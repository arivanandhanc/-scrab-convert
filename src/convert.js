/**
 * The LibreOffice call, with the three guards that stop it hanging.
 *
 * Everything here exists because `soffice --convert-to` is not a well-behaved
 * subprocess. It can wedge on a corrupt file, it can wait forever on a modal
 * dialog nobody will ever click, and two instances sharing a profile directory
 * will silently refuse to start. Each of those looks identical from the outside
 * — a request that never returns — which is precisely the failure the site is
 * already suffering from elsewhere.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Hard ceiling on one conversion. Nothing legitimate takes this long. */
export const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS ?? 60_000);

/**
 * What LibreOffice can write, keyed by the target we expose.
 *
 * The value is the filter string passed to --convert-to. Where a plain
 * extension would be ambiguous the explicit filter is spelled out, because
 * LibreOffice picks a default that is occasionally not the one you want
 * (`csv` without a filter writes the first sheet only, silently).
 */
export const TARGETS = {
  pdf: "pdf",
  docx: "docx:MS Word 2007 XML",
  doc: "doc:MS Word 97",
  odt: "odt",
  rtf: "rtf:Rich Text Format",
  txt: "txt:Text (encoded):UTF8",
  html: "html:HTML (StarWriter)",
  xlsx: "xlsx:Calc MS Excel 2007 XML",
  xls: "xls:MS Excel 97",
  ods: "ods",
  csv: "csv:Text - txt - csv (StarCalc):44,34,76,1",
  pptx: "pptx:Impress MS PowerPoint 2007 XML",
  ppt: "ppt:MS PowerPoint 97",
  odp: "odp",
};

/** Inputs we accept. Anything else is rejected before a process is spawned. */
export const SOURCES = new Set([
  "doc", "docx", "odt", "rtf", "txt", "html", "htm",
  "xls", "xlsx", "ods", "csv", "tsv",
  "ppt", "pptx", "odp",
]);

export class ConvertError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

/**
 * Convert one buffer and resolve to the result buffer.
 *
 * @param {Buffer} input
 * @param {string} sourceExt  extension without the dot, already validated
 * @param {string} target     key of TARGETS
 */
export async function convert(input, sourceExt, target) {
  const filter = TARGETS[target];
  if (!filter) throw new ConvertError(`Cannot convert to ${target}.`);
  if (!SOURCES.has(sourceExt)) throw new ConvertError(`Cannot read .${sourceExt} files.`);

  // Guard 1: a private profile per job. Two soffice processes sharing one
  // UserInstallation is the classic "second request hangs forever" bug — the
  // second instance waits on a lock the first will not release until it exits.
  const jobDir = await mkdtemp(path.join(tmpdir(), "conv-"));
  const profile = path.join(jobDir, "profile");
  const inPath = path.join(jobDir, `in.${sourceExt}`);
  const outDir = path.join(jobDir, "out");

  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await writeFile(inPath, input);
    await mkdir(outDir, { recursive: true });

    await runSoffice([
      "--headless",
      "--norestore",
      // Guard 2: every dialog LibreOffice might raise, disabled. A dialog on a
      // headless server is an infinite wait — there is no one to dismiss it.
      "--nolockcheck",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=file://${profile.replace(/\\/g, "/")}`,
      "--convert-to", filter,
      "--outdir", outDir,
      inPath,
    ]);

    // LibreOffice names the output itself and exits 0 even when it produced
    // nothing at all, so the only trustworthy check is whether a file appeared.
    const produced = await readdir(outDir);
    if (!produced.length) {
      throw new ConvertError(
        "LibreOffice produced no output. The file may be corrupt or password-protected.",
        422
      );
    }

    const outPath = path.join(outDir, produced[0]);
    return { buffer: await readFile(outPath), filename: produced[0] };
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Guard 3: a wall-clock deadline, enforced by killing the process group.
 *
 * SIGTERM first so LibreOffice can clean up its lock files, then SIGKILL if it
 * ignores that — which it does, often enough to matter.
 */
function runSoffice(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("soffice", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (d) => {
      // Cap it: a wedged LibreOffice can emit warnings indefinitely, and
      // buffering all of them turns a hung request into a memory leak too.
      if (stderr.length < 4096) stderr += d.toString();
    });

    const killer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000);
      reject(
        new ConvertError(
          `Conversion timed out after ${Math.round(TIMEOUT_MS / 1000)}s. The file is too large or too complex.`,
          504
        )
      );
    }, TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(killer);
      reject(new ConvertError(`Could not start LibreOffice: ${err.message}`, 500));
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new ConvertError(`LibreOffice exited with code ${code}. ${stderr.slice(0, 300)}`, 422));
    });
  });
}

/** Job ids are opaque and only used for log correlation. */
export const newJobId = () => randomUUID().slice(0, 8);
