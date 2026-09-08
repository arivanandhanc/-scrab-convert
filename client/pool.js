/**
 * Client-side failover across several conversion servers.
 *
 * This is the whole "load balancer" — no extra service, no DNS tricks, nothing
 * else to keep alive. A real load balancer would itself need hosting that never
 * goes down, which is the problem we are trying to solve, not a solution to it.
 * The browser is already the one place guaranteed to be up whenever a user is
 * converting something, so it does the choosing.
 *
 * Runs in the browser. Copy it into whatever frontend calls the pool, or import
 * it directly — it has no dependencies.
 */

/**
 * Order matters: this is the preference list. Put the host with the best
 * free-tier headroom first and the sleepiest one last, because a cold instance
 * that has to wake up still beats no instance at all.
 *
 * @typedef {{ name: string, url: string }} Backend
 */

/** How long an instance gets to answer a health check before we move on. */
const HEALTH_TIMEOUT_MS = 2500;

/**
 * Ask every backend how it is doing, in parallel, and rank them.
 *
 * Parallel rather than sequential on purpose: checking three servers one after
 * another costs three timeouts in the worst case, and the worst case is exactly
 * when a user is already waiting.
 *
 * @param {Backend[]} backends
 * @returns {Promise<Array<Backend & { health: any, ms: number }>>} healthy only, best first
 */
export async function probe(backends) {
  const checks = backends.map(async (backend) => {
    const began = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const res = await fetch(`${backend.url}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const health = await res.json();
      return { ...backend, health, ms: Date.now() - began };
    } catch {
      // Down, asleep, or over quota. All three mean "not this one", and the
      // distinction is not worth a second request to find out.
      return null;
    }
  });

  const alive = (await Promise.all(checks)).filter(Boolean);

  // A free instance beats a busy one regardless of how fast it answered; among
  // equals, prefer the one that replied quickest, which is a decent proxy for
  // "already warm and close to the user".
  return alive.sort((a, b) => {
    if (a.health.busy !== b.health.busy) return a.health.busy ? 1 : -1;
    const queued = (a.health.queued ?? 0) - (b.health.queued ?? 0);
    return queued !== 0 ? queued : a.ms - b.ms;
  });
}

/**
 * Convert a file, trying each healthy backend in turn.
 *
 * A 503 means that instance filled up between the health check and the upload,
 * so we move on immediately. Any other error is the file's fault, not the
 * server's, and retrying it elsewhere would just fail three times as slowly.
 *
 * @param {Backend[]} backends
 * @param {File} file
 * @param {string} target
 * @param {{ onAttempt?: (b: Backend) => void }} [opts]
 */
export async function convertWithFailover(backends, file, target, opts = {}) {
  const ranked = await probe(backends);
  if (!ranked.length) {
    throw new Error("No conversion server is available right now. Please try again in a minute.");
  }

  let lastError = null;

  for (const backend of ranked) {
    opts.onAttempt?.(backend);
    try {
      const body = new FormData();
      body.append("file", file);

      const res = await fetch(`${backend.url}/convert?to=${encodeURIComponent(target)}`, {
        method: "POST",
        body,
      });

      if (res.ok) {
        return {
          blob: await res.blob(),
          server: backend.name,
          ms: Number(res.headers.get("X-Convert-Ms") ?? 0),
        };
      }

      if (res.status === 503) {
        lastError = new Error("Server was at capacity.");
        continue; // Next instance — this one filled up.
      }

      // 4xx and 5xx that aren't capacity are about this file. Stop.
      const { error } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(error);
    } catch (err) {
      // A network-level failure is worth retrying elsewhere; a rejection we
      // raised ourselves above is not, and rethrowing it here would lose that.
      if (err instanceof TypeError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Every conversion server refused the request.");
}
