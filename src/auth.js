/**
 * Keeping the conversion server to our own site.
 *
 * WHAT DOES NOT WORK, AND WHY IT IS HERE ANYWAY
 * CORS and the Origin header are not security. Both are enforced by browsers,
 * and a script has no browser: `curl -H "Origin: https://www.scrabtools.site"`
 * defeats either in one line. We proved this repeatedly while building the
 * thing — every command-line test passed while the browser was blocked.
 *
 * So the Origin check below is a cheap filter for casual traffic, not a wall,
 * and it is deliberately not the thing standing between an attacker and the
 * bill.
 *
 * WHAT ACTUALLY WORKS
 * A short-lived token, signed with a secret the browser never sees. The site's
 * own server mints it; this server verifies it. A bot cannot forge one without
 * the secret, and cannot steal one from the page because it is issued per
 * request and expires in two minutes.
 *
 * The secret therefore lives in exactly two places -- this Lambda's environment
 * and the website's server environment -- and in neither case is it shipped to
 * a browser. Putting it in a NEXT_PUBLIC_ variable would publish it in the page
 * source and undo the whole design.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.CONVERT_SHARED_SECRET ?? "";

/** How long a minted token stays valid. Long enough to pick a format, no more. */
const TOKEN_TTL_MS = 2 * 60 * 1000;

/** Origins allowed to appear on a browser request. Empty means "any". */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

/**
 * Per-IP rate limit, in memory.
 *
 * In memory is the right scope here: each Lambda execution environment handles
 * one request at a time and there are at most two, so a shared store would add
 * a dependency to bound something the concurrency cap already bounds. This
 * exists to stop one caller monopolising those two slots, not to be a
 * distributed quota.
 */
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 20);
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  recent.push(now);
  hits.set(ip, recent);

  // Keep the map from growing without bound across a warm environment's life.
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => t > windowStart)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT;
}

/** The signature the website's server produces for a given expiry. */
export function sign(expiresAt) {
  return createHmac("sha256", SECRET).update(String(expiresAt)).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare lengths first and always in constant time after.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a request. Returns null when it is allowed, or {status, error} when
 * it is not.
 */
export function check(req) {
  // Unset secret means the lockdown is not configured. Fail closed: an open
  // converter is a bill someone else gets to run up, and "it stopped working"
  // is a far better failure than "it worked for everyone".
  if (!SECRET) {
    return { status: 503, error: "Server is not configured for authenticated access." };
  }

  const ip =
    (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (rateLimited(ip)) {
    return { status: 429, error: "Too many requests. Please wait a minute." };
  }

  if (ALLOWED_ORIGINS.length) {
    const origin = (req.headers.origin ?? "").replace(/\/$/, "");
    // Absent Origin is allowed through to the token check: server-to-server
    // callers legitimately send none, and rejecting on it would only block the
    // honest ones while a bot sets whatever string it likes.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return { status: 403, error: "This server only serves scrabtools.site." };
    }
  }

  const token = req.headers["x-convert-token"];
  if (!token || typeof token !== "string") {
    return { status: 401, error: "Missing access token." };
  }

  const [expRaw, signature] = token.split(".");
  const expiresAt = Number(expRaw);
  if (!expiresAt || !signature) {
    return { status: 401, error: "Malformed access token." };
  }
  if (Date.now() > expiresAt) {
    return { status: 401, error: "Access token expired. Refresh the page and try again." };
  }
  // A token minted far in the future would never expire, so cap how far ahead
  // a caller may claim -- otherwise a single leaked token lasts forever.
  if (expiresAt - Date.now() > TOKEN_TTL_MS + 30_000) {
    return { status: 401, error: "Access token expiry is out of range." };
  }
  if (!safeEqual(signature, sign(expiresAt))) {
    return { status: 401, error: "Invalid access token." };
  }

  return null;
}

export const AUTH_CONFIGURED = Boolean(SECRET);
export { TOKEN_TTL_MS };
