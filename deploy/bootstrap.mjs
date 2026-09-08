#!/usr/bin/env node
/**
 * One-time AWS setup, cost caps first.
 *
 * Run once, before the first deploy. Everything here is idempotent, so running
 * it again after a change is safe and is the intended way to adjust a limit.
 *
 * The ordering is deliberate: every spend control is created *before* the thing
 * it controls. An ECR repository without a lifecycle policy quietly accumulates
 * a 500 MB image per deploy, and a Lambda log group without a retention policy
 * keeps logs forever by default — both bill monthly, for storage nobody reads.
 * Creating them in the other order means paying for the gap.
 *
 *   node deploy/bootstrap.mjs
 *
 * Needs AWS credentials in the environment or ~/.aws/credentials, with the
 * policy in deploy/aws-iam-policy.json attached.
 */

import {
  ECRClient, CreateRepositoryCommand, PutLifecyclePolicyCommand, DescribeRepositoriesCommand,
  SetRepositoryPolicyCommand,
} from "@aws-sdk/client-ecr";
import {
  IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand,
} from "@aws-sdk/client-iam";
import {
  CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { BudgetsClient, CreateBudgetCommand } from "@aws-sdk/client-budgets";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const NAME = "scrab-convert";
const ROLE = `${NAME}-exec`;

/**
 * Keep exactly one image. Each build is ~500 MB, and ECR bills $0.10/GB/month,
 * so ten forgotten builds is 5 GB — about ₹42/month for nothing. The previous
 * image is worth keeping only until the new one is confirmed working, and
 * rollback is a rebuild from a git tag, which is free.
 */
const KEEP_IMAGES = 1;

/** Logs are for debugging a failure that just happened, not an archive. */
const LOG_RETENTION_DAYS = 3;

/** Ceiling in USD. Alerts fire at 50% and 100% of this. */
const MONTHLY_BUDGET_USD = "0.60";

const say = (ok, msg) => console.log(`${ok ? "  ok" : "SKIP"}  ${msg}`);

async function idempotent(label, fn) {
  try {
    await fn();
    say(true, label);
  } catch (err) {
    // Every "already exists" shape AWS uses, across four services.
    if (/AlreadyExists|Duplicate|EntityAlreadyExists|ResourceAlreadyExistsException/.test(err.name)) {
      say(false, `${label} — already present`);
      return;
    }
    if (err.name === "AccessDeniedException" || err.name === "AccessDenied") {
      console.error(`  !!  ${label} — access denied. Is deploy/aws-iam-policy.json attached?`);
      return;
    }
    throw err;
  }
}

const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
console.log(`account ${account} · region ${REGION}\n`);

// ── 1. Registry, with the lifecycle policy applied immediately ──────────────
const ecr = new ECRClient({ region: REGION });

await idempotent(`ECR repository ${NAME}`, () =>
  ecr.send(new CreateRepositoryCommand({
    repositoryName: NAME,
    // Scan on push is free for basic scanning and catches a known-CVE base
    // image before it is running rather than after.
    imageScanningConfiguration: { scanOnPush: true },
    imageTagMutability: "MUTABLE",
  }))
);

await idempotent(`ECR lifecycle policy (keep ${KEEP_IMAGES})`, () =>
  ecr.send(new PutLifecyclePolicyCommand({
    repositoryName: NAME,
    lifecyclePolicyText: JSON.stringify({
      rules: [{
        rulePriority: 1,
        description: `Keep only the ${KEEP_IMAGES} most recent image(s); storage is billed monthly.`,
        selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: KEEP_IMAGES },
        action: { type: "expire" },
      }],
    }),
  }))
);

/**
 * Let Lambda pull from this repository.
 *
 * Lambda fetches the image as its own service principal, not as the caller, so
 * being in the same account is not enough — without this the function refuses
 * to create with "Lambda does not have permission to access the ECR image",
 * which sounds like a caller-credentials problem and is not one. The console
 * adds this policy silently when you choose an image; the API does not, so it
 * belongs here.
 *
 * The sourceArn condition keeps the grant to this account's functions rather
 * than to the Lambda service at large.
 */
await idempotent("ECR policy allowing Lambda to pull", () =>
  ecr.send(new SetRepositoryPolicyCommand({
    repositoryName: NAME,
    policyText: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "LambdaECRImageRetrievalPolicy",
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Condition: {
          StringLike: { "aws:sourceArn": `arn:aws:lambda:${REGION}:${account}:function:*` },
        },
      }],
    }),
  }))
);

// ── 2. Execution role ───────────────────────────────────────────────────────
const iam = new IAMClient({ region: REGION });

await idempotent(`IAM role ${ROLE}`, () =>
  iam.send(new CreateRoleCommand({
    RoleName: ROLE,
    Description: "Execution role for the scrab-convert Lambda. Logs only.",
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    }),
  }))
);

// Basic execution is only CreateLogGroup/CreateLogStream/PutLogEvents. The
// function converts a buffer in memory and touches no other AWS service, so it
// needs nothing more — and anything more would be a permission to misuse.
await idempotent("attach AWSLambdaBasicExecutionRole", () =>
  iam.send(new AttachRolePolicyCommand({
    RoleName: ROLE,
    PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  }))
);

// ── 3. Log group, created ahead of the function so retention is set from the
//       first line rather than after a month of unbounded logs. ─────────────
const logs = new CloudWatchLogsClient({ region: REGION });
const logGroup = `/aws/lambda/${NAME}`;

await idempotent(`log group ${logGroup}`, () =>
  logs.send(new CreateLogGroupCommand({ logGroupName: logGroup }))
);

await idempotent(`log retention ${LOG_RETENTION_DAYS} days`, () =>
  logs.send(new PutRetentionPolicyCommand({
    logGroupName: logGroup,
    retentionInDays: LOG_RETENTION_DAYS,
  }))
);

// ── 4. Budget alarm ─────────────────────────────────────────────────────────
// An alert, not a stop: AWS has no hard spending cut-off. It exists so a
// surprise is measured in hours rather than discovered on the monthly bill.
const email = process.env.ALERT_EMAIL;
if (!email) {
  say(false, "budget alert — set ALERT_EMAIL to create it");
} else {
  const budgets = new BudgetsClient({ region: "us-east-1" }); // Budgets is us-east-1 only.
  await idempotent(`budget $${MONTHLY_BUDGET_USD}/month → ${email}`, () =>
    budgets.send(new CreateBudgetCommand({
      AccountId: account,
      Budget: {
        BudgetName: `${NAME}-monthly`,
        BudgetLimit: { Amount: MONTHLY_BUDGET_USD, Unit: "USD" },
        TimeUnit: "MONTHLY",
        BudgetType: "COST",
      },
      NotificationsWithSubscribers: [50, 100].map((pct) => ({
        Notification: {
          NotificationType: "ACTUAL",
          ComparisonOperator: "GREATER_THAN",
          Threshold: pct,
          ThresholdType: "PERCENTAGE",
        },
        Subscribers: [{ SubscriptionType: "EMAIL", Address: email }],
      })),
    }))
  );
}

// Read back what was created, and say plainly when nothing was. A stack trace
// here would bury the one thing worth knowing: the policy is not attached yet.
try {
  const repo = (await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [NAME] })))
    .repositories[0].repositoryUri;

  console.log(`\nECR_REPOSITORY=${repo}`);
  console.log(`LAMBDA_ROLE_ARN=arn:aws:iam::${account}:role/${ROLE}`);
  console.log("\nSetup complete. Push to main and the workflow builds and deploys.");
} catch (err) {
  if (err.name === "AccessDeniedException" || err.name === "RepositoryNotFoundException") {
    console.error(`\nNothing was created — the deploy user has no permissions yet.`);
    console.error(`Attach deploy/aws-iam-policy.json to the IAM user, then run this again.`);
    console.error(`It is idempotent, so re-running costs nothing and skips what exists.`);
    process.exit(1);
  }
  throw err;
}
