#!/usr/bin/env node
/**
 * Create or update the Lambda function from an image already in ECR.
 *
 * Kept as a script rather than YAML so it runs identically from a laptop and
 * from CI, and so the reasoning behind each number lives next to the number.
 *
 *   node deploy/deploy-lambda.mjs <image-uri>
 */

import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  CreateFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  AddPermissionCommand,
  PutFunctionConcurrencyCommand,
} from "@aws-sdk/client-lambda";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const NAME = "scrab-convert";
const IMAGE = process.argv[2];

if (!IMAGE) {
  console.error("usage: node deploy/deploy-lambda.mjs <image-uri>");
  process.exit(1);
}

/**
 * Lambda allocates CPU in proportion to memory — one full vCPU at 1,769 MB.
 * LibreOffice is CPU-bound, so under-provisioning memory makes conversions
 * slower without making them cheaper: billing is GB-seconds, and halving the
 * memory roughly doubles the duration. 2 GB buys just over one vCPU and is the
 * cheapest point that isn't deliberately slow.
 *
 * Against the 400,000 GB-second monthly free tier this is 200,000 seconds of
 * execution, or roughly 66,000 conversions at three seconds each.
 */
const MEMORY_MB = 2048;

/** Above the app's own 90s guard, so the app's clean 504 wins over Lambda's. */
const TIMEOUT_S = 120;

/**
 * The free tier for /tmp is 512 MB; anything above it is billed per GB-second.
 * A LibreOffice profile is ~20 MB and the files are capped at 5 MB, so 512 is
 * both sufficient and the only size that stays free.
 */
const EPHEMERAL_MB = 512;

/**
 * The real spending cap. Lambda's free tier is generous but not a wall, so this
 * bounds how fast money can possibly be spent: at most two conversions run at
 * once, no matter what arrives. A traffic spike becomes queueing and 429s --
 * visible, recoverable -- rather than a bill.
 */
const MAX_PARALLEL = 2;

const env = {
  // Lambda serves one request per execution environment, so in-process
  // concurrency would only compete with itself for the same CPU.
  MAX_CONCURRENT: "1",
  // Lambda's own request payload ceiling is 6 MB; 5 leaves room for the
  // multipart envelope. Above this the platform rejects the request before any
  // of our code runs, so the app must refuse first to give a usable error.
  MAX_UPLOAD_BYTES: String(5 * 1024 * 1024),
  CONVERT_TIMEOUT_MS: "90000",
  QUEUE_TIMEOUT_MS: "10000",
  AWS_LWA_READINESS_CHECK_PATH: "/health",
};

const lambda = new LambdaClient({ region: REGION });

// GetCallerIdentity needs no permission of its own, so this is a free and
// unambiguous way to build the role ARN — better than parsing the account id
// out of the image URI, which happens to work but breaks the moment the
// registry host format changes.
const { Account } = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
const roleArn = `arn:aws:iam::${Account}:role/${NAME}-exec`;

async function exists() {
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: NAME }));
    return true;
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

/**
 * Lambda rejects configuration changes while a previous update is still
 * settling, and the code and configuration updates here are back to back.
 */
async function waitUntilSettled() {
  for (let i = 0; i < 40; i++) {
    const { Configuration } = await lambda.send(new GetFunctionCommand({ FunctionName: NAME }));
    if (Configuration.LastUpdateStatus !== "InProgress" && Configuration.State !== "Pending") return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Function did not become ready within two minutes.");
}

/**
 * Merge with whatever is already on the function, rather than replacing it.
 *
 * UpdateFunctionConfiguration replaces the environment wholesale: any variable
 * not named in this call is deleted. Secrets are deliberately not in this file
 * -- they are set by hand in the console and must never be committed -- so a
 * plain overwrite silently removes them on the next deploy, and the service
 * comes back up unable to authenticate anything. That is exactly what happened
 * on the first deploy after the lockdown shipped.
 *
 * The values below still win for the keys they own; everything else survives.
 */
async function mergedEnv() {
  const { Environment } = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName: NAME })
  );
  return { ...(Environment?.Variables ?? {}), ...env };
}

if (await exists()) {
  console.log("updating existing function");
  const preserved = await mergedEnv();
  const kept = Object.keys(preserved).filter((k) => !(k in env));
  if (kept.length) console.log(`preserving ${kept.length} manually-set variable(s): ${kept.join(", ")}`);

  await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: NAME, ImageUri: IMAGE }));
  await waitUntilSettled();
  await lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: NAME,
    MemorySize: MEMORY_MB,
    Timeout: TIMEOUT_S,
    EphemeralStorage: { Size: EPHEMERAL_MB },
    Environment: { Variables: preserved },
  }));
} else {
  console.log("creating function");
  await lambda.send(new CreateFunctionCommand({
    FunctionName: NAME,
    PackageType: "Image",
    Code: { ImageUri: IMAGE },
    Role: roleArn,
    MemorySize: MEMORY_MB,
    Timeout: TIMEOUT_S,
    EphemeralStorage: { Size: EPHEMERAL_MB },
    Environment: { Variables: env },
    Description: "LibreOffice document conversion. github.com/arivanandhanc/-scrab-convert",
  }));
}

await waitUntilSettled();

await lambda.send(new PutFunctionConcurrencyCommand({
  FunctionName: NAME,
  ReservedConcurrentExecutions: MAX_PARALLEL,
}));
console.log(`concurrency capped at ${MAX_PARALLEL}`);

// ── Public URL ──────────────────────────────────────────────────────────────
// AuthType NONE because browsers call this directly and cannot sign requests.
// The exposure is bounded by the concurrency cap above and by the fact that
// the function can do nothing but convert a buffer and write a log line.
/**
 * CORS, without which a browser refuses the response even though the request
 * succeeded — and curl, which ignores CORS entirely, reports everything as
 * fine. That gap is worth guarding: a URL recreated by hand in the console
 * comes back with no CORS at all, which looks like a dead server from the app
 * and a healthy one from the command line.
 */
const CORS = {
  AllowOrigins: ["*"],
  AllowMethods: ["GET", "POST"],
  AllowHeaders: ["content-type"],
  ExposeHeaders: ["content-disposition", "x-convert-ms"],
  MaxAge: 86400,
};

let url;
try {
  const existing = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: NAME }));
  url = existing.FunctionUrl;
  // Reassert it every deploy rather than trusting what is there.
  if (!existing.Cors?.AllowOrigins?.length) {
    await lambda.send(new UpdateFunctionUrlConfigCommand({
      FunctionName: NAME,
      AuthType: "NONE",
      Cors: CORS,
    }));
    console.log("restored missing CORS configuration");
  }
} catch (err) {
  if (err.name !== "ResourceNotFoundException") throw err;
  url = (await lambda.send(new CreateFunctionUrlConfigCommand({
    FunctionName: NAME,
    AuthType: "NONE",
    Cors: CORS,
  }))).FunctionUrl;

  // A Function URL with AuthType NONE still needs this resource policy before
  // it will answer an unsigned request. Without it every call returns 403 and
  // the URL looks broken rather than unauthorised.
  await lambda.send(new AddPermissionCommand({
    FunctionName: NAME,
    StatementId: "AllowPublicFunctionUrl",
    Action: "lambda:InvokeFunctionUrl",
    Principal: "*",
    FunctionUrlAuthType: "NONE",
  }));
}

console.log(`\nFUNCTION_URL=${url}`);
console.log(`\nTry it:\n  curl ${url}health`);
