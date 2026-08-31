/**
 * CORS for the public surface.
 *
 * Deliberately registered *before* the body parser, so that a 413 or a
 * malformed-JSON 400 still carries the CORS headers. Without that the browser
 * swallows the real status and the developer sees only "blocked by CORS" — the
 * single most misleading failure mode in this whole system.
 *
 * Preflight cannot know which widget is being submitted to, because an OPTIONS
 * request has no body. So preflight is answered for any origin, and the
 * per-widget allow-list is enforced on the POST itself, in the service layer.
 */
export function publicCors(req, res, next) {
  const origin = req.get('origin');

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // The response varies by origin, so caches must key on it.
    res.setHeader('Vary', 'Origin');
  } else {
    // A page opened straight from disk sends no Origin header at all.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
}

/** The same idea for the cached script and config responses, which are open to all. */
export function openCors(req, res, next) {
  // A wildcard, not a reflected origin: these responses are cached, and caching
  // a per-origin value under one URL is how you serve the wrong header to
  // somebody else.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}
