import express from 'express';
import { config } from '../lib/config.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  // We sit behind Docker / a reverse proxy, so the visitor's real IP arrives in
  // X-Forwarded-For. Trusting exactly one hop keeps rate limiting honest without
  // letting a client spoof the whole chain.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(requestContext);
  app.use(express.json({ limit: config.SUBMISSION_BODY_LIMIT }));

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
