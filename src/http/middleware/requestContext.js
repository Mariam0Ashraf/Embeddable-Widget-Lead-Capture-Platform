import { requestId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';

/** Tags every request with an id and logs one line per completed response. */
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || requestId();
  res.setHeader('X-Request-Id', req.id);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      request_id: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Math.round(ms * 10) / 10,
    });
  });

  next();
}
