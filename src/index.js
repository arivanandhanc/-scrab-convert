/**
 * Scrab Convert — HTTP front for the LibreOffice worker.
 *
 * Small on purpose. This service does one thing, and every extra moving part is
 * another thing that can be down when the router health-checks it.
 *
 * The design assumption is that several copies of this run on different hosts
 * and something in front picks between them, so `/health` is treated as a real
 * API rather than a liveness ping: it reports whether this copy is warm and how
 * much headroom it has, which is what a router needs to choose well.
 */

import express from "express";
import multer from "multer";
import cors from "cors";
import path from "node:path";
import { convert, ConvertError, TARGETS, SOURCES, TIMEOUT_MS, newJobId } from "./convert.js";

const PORT = Number(process.env.PORT ?? 8080);

/**
 * How many conversions run at once.
 *
 * LibreOffice needs roughly 250–400 MB per instance, so this is really a
 * statement about the host's memory. Default 2 fits a 1 GB container with room
 * for Node; a 512 MB host must set this to 1 or it will be OOM-killed mid-job,
 * which the platform reports as a crash rather than a failed request.
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);

/** Requests wait this long for a free slot before being turned away. */
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS ?? 15_000);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    // No allowlist configured means local development; in production the
    // deploy sets CORS_ORIGINS and anything else is refused.
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// ── Concurrency gate ────────────────────────────────────────────────────────
// A counting semaphore rather than a real queue library. The whole point is to
// refuse work this box cannot do, quickly, so the router can send it elsewhere
// — a deep queue would just convert a fast rejection into a slow one.
let active = 0;
const waiting = [];
const startedAt = Date.now();
let completed = 0;
let failed = 0;

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { resolve };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i > -1) waiting.splice(i, 1);
      resolve(false);
    }, QUEUE_TIMEOUT_MS);
    waiting.push(entry);
  });
}

function release() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true);
    return;
  }
  active = Math.max(0, active - 1);
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * Health, with the numbers a router needs to rank this instance.
 *
 * `busy` is the signal that matters: an instance at capacity should be skipped
 * even though it is perfectly healthy, and an instance that is up but queueing
 * is worse than a cold one that is free.
 */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "scrab-convert",
    region: process.env.FLY_REGION ?? process.env.RENDER_REGION ?? process.env.REGION ?? "unknown",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    active,
    queued: waiting.length,
    capacity: MAX_CONCURRENT,
    busy: active >= MAX_CONCURRENT,
    completed,
    failed,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
});

/** The format matrix, so the frontend badge never drifts from reality. */
app.get("/capabilities", (_req, res) => {
  res.json({
    sources: [...SOURCES].sort(),
    targets: Object.keys(TARGETS).sort(),
    maxUploadBytes: MAX_UPLOAD_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
});

app.post("/convert", upload.single("file"), async (req, res) => {
  const job = newJobId();
  const target = String(req.query.to ?? req.body?.to ?? "").toLowerCase();

  if (!req.file) return res.status(400).json({ error: "No file uploaded.", job });
  if (!TARGETS[target]) {
    return res.status(400).json({ error: `Unsupported target "${target}".`, job });
  }

  const sourceExt = path.extname(req.file.originalname).slice(1).toLowerCase();
  if (!SOURCES.has(sourceExt)) {
    return res.status(400).json({ error: `Cannot read .${sourceExt} files.`, job });
  }

  const slot = await acquire();
  if (!slot) {
    // 503 + Retry-After is the honest answer, and it is what tells a router to
    // try the next instance instead of waiting on this one.
    res.set("Retry-After", "5");
    return res.status(503).json({ error: "Server is at capacity. Try another instance.", job });
  }

  const began = Date.now();
  try {
    const { buffer, filename } = await convert(req.file.buffer, sourceExt, target);
    completed++;
    const base = path.basename(req.file.originalname, path.extname(req.file.originalname));
    console.log(
      JSON.stringify({ job, from: sourceExt, to: target, ms: Date.now() - began, bytes: buffer.length })
    );
    res.set("Content-Disposition", `attachment; filename="${sanitize(base)}.${target}"`);
    res.set("X-Convert-Ms", String(Date.now() - began));
    res.type("application/octet-stream").send(buffer);
  } catch (err) {
    failed++;
    const status = err instanceof ConvertError ? err.code : 500;
    console.error(JSON.stringify({ job, from: sourceExt, to: target, status, error: err.message }));
    res.status(status).json({ error: err.message, job });
  } finally {
    release();
  }
});

/** Strip anything that could escape the Content-Disposition quoting. */
function sanitize(name) {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "converted";
}

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` });
  }
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(
    `scrab-convert listening on ${PORT} · concurrency ${MAX_CONCURRENT} · timeout ${TIMEOUT_MS}ms`
  );
});
