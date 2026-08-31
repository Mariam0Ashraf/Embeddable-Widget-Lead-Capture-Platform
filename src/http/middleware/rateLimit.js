import { config } from '../../lib/config.js';
import { tooManyRequests } from '../../lib/errors.js';
import { clientIp } from '../../lib/net.js';
import { createRateLimiter, logLimitHit } from '../../lib/rateLimiter.js';

export const ipLimiter = createRateLimiter({
  name: 'per_ip',
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_PER_IP,
});

export const widgetLimiter = createRateLimiter({
  name: 'per_widget',
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_PER_WIDGET,
});

function applyHeaders(res, limiter, result) {
  res.setHeader('X-RateLimit-Limit', limiter.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Policy', limiter.limit + ';w=' + Math.round(limiter.windowMs / 1000));
}

/**
 * Per-IP limit. Runs before the widget is looked up, so a flood costs one map
 * lookup rather than a database round trip. That is the entire point of it: the
 * API has to keep serving everyone else while one address hammers it.
 */
export function rateLimitByIp(req, res, next) {
  const ip = clientIp(req) ?? 'unknown';
  const result = ipLimiter.check('ip:' + ip);
  applyHeaders(res, ipLimiter, result);

  if (!result.allowed) {
    logLimitHit({ limiter: ipLimiter, key: ip, requestId: req.id });
    res.setHeader('Retry-After', result.retryAfterSeconds);
    return next(
      tooManyRequests('Too many requests from this address — slow down', {
        scope: 'ip',
        retry_after_seconds: result.retryAfterSeconds,
      }),
    );
  }
  return next();
}

/** Per-widget limit, keyed on the id in the body. Caps one widget's blast radius. */
export function rateLimitByWidget(req, res, next) {
  const widgetId = req.body?.widget_id;
  if (typeof widgetId !== 'string' || widgetId.length === 0) return next();

  const result = widgetLimiter.check('widget:' + widgetId);
  if (!result.allowed) {
    logLimitHit({ limiter: widgetLimiter, key: widgetId, requestId: req.id });
    res.setHeader('Retry-After', result.retryAfterSeconds);
    return next(
      tooManyRequests('This widget is receiving too many submissions right now', {
        scope: 'widget',
        retry_after_seconds: result.retryAfterSeconds,
      }),
    );
  }
  return next();
}

/** Test seam: the limiters are process-wide, so suites must be able to clear them. */
export function resetRateLimiters() {
  ipLimiter.reset();
  widgetLimiter.reset();
}
