import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isProduction } from '../../lib/config.js';

/** 404 for anything no route claimed. Registered after all routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
}

/**
 * The single place an error becomes a status code. Every failure the API is
 * allowed to produce is a 4xx with a JSON body; a 5xx here means we hit a bug,
 * and the client is told nothing beyond a request id.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    const body = { error: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  // body-parser failures arrive as plain errors; they are client mistakes, not ours.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'payload_too_large',
      message: 'Request body exceeds the maximum allowed size',
    });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  }
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(415).json({ error: 'unsupported_media_type', message: 'Unsupported encoding' });
  }

  logger.error('unhandled error', {
    request_id: req.id,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    error: err.message,
    stack: isProduction ? undefined : err.stack,
  });

  return res.status(500).json({
    error: 'internal_error',
    message: 'Something went wrong on our side',
    request_id: req.id,
  });
}
