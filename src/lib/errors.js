// Services throw these; one HTTP error handler turns them into a status + JSON
// body. Nothing below src/http needs to know what a response object is.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const validationFailed = (details) =>
  new AppError(400, 'validation_failed', 'Request body failed validation', details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not permitted') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Resource not found') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const payloadTooLarge = (message = 'Payload too large') =>
  new AppError(413, 'payload_too_large', message);
export const tooManyRequests = (message, details) =>
  new AppError(429, 'rate_limited', message, details);
