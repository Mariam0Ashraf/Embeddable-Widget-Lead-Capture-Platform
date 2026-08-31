import { Router } from 'express';
import { query } from '../../lib/db.js';
import { config } from '../../lib/config.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  let database = 'up';
  try {
    await query('SELECT 1');
  } catch {
    database = 'down';
  }

  const ok = database === 'up';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    database,
    widget_build: config.WIDGET_BUILD_VERSION,
    uptime_s: Math.round(process.uptime()),
  });
});
