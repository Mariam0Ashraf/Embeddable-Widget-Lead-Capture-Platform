import express from 'express';
import { config } from '../lib/config.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { widgetsRouter } from './routes/widgets.js';
import { publicSubmissionsRouter } from './routes/publicSubmissions.js';
import { publicCors } from './middleware/publicCors.js';
import { widgetDeliveryRouter } from './routes/widgetDelivery.js';

export function createApp() {
  const app = express();

  // We sit behind Docker / a reverse proxy, so the visitor's real IP arrives in
  // X-Forwarded-For. Trusting exactly one hop keeps rate limiting honest without
  // letting a client spoof the whole chain.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(requestContext);

  // Registered before the body parser on purpose: a 413 or a malformed-JSON 400
  // must still carry CORS headers, or the browser hides the real status behind a
  // generic CORS error and the customer's developer cannot debug their own form.
  app.use('/api/public', publicCors);

  app.use(express.json({ limit: config.SUBMISSION_BODY_LIMIT }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(widgetsRouter);
  app.use(publicSubmissionsRouter);
  app.use(widgetDeliveryRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
