import { logger } from './logger.js';

/**
 * Sliding-window counter held in memory. One process, one map — deliberately
 * not Redis: the brief's stack is free and local, and an in-process limiter is
 * exactly as correct for a single API container while being far easier to prove.
 * The trade-off (limits reset on restart, counts are per-process) is stated in
 * the README's limitations section rather than hidden.
 */
export function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  function sweep(now) {
    for (const [key, timestamps] of hits) {
      const live = timestamps.filter((t) => now - t < windowMs);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  // Without this the map grows for every IP ever seen — a slow memory leak that
  // only shows up in production.
  const sweeper = setInterval(() => sweep(Date.now()), windowMs).unref();

  return {
    name,
    limit: max,
    windowMs,

    /** Records a hit and reports whether the caller is over the limit. */
    check(key) {
      const now = Date.now();
      const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

      if (timestamps.length >= max) {
        hits.set(key, timestamps);
        const retryAfterMs = windowMs - (now - timestamps[0]);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }

      timestamps.push(now);
      hits.set(key, timestamps);
      return { allowed: true, remaining: max - timestamps.length, retryAfterSeconds: 0 };
    },

    reset() {
      hits.clear();
    },

    stop() {
      clearInterval(sweeper);
    },
  };
}

export function logLimitHit({ limiter, key, requestId }) {
  logger.warn('rate limit exceeded', { limiter: limiter.name, key, request_id: requestId });
}
