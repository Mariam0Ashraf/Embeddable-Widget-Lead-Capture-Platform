import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { isUuid, parseOrThrow } from '../../lib/validate.js';
import { notFound } from '../../lib/errors.js';
import {
  getOverview,
  getSubmission,
  getSubmissions,
  statsQuerySchema,
  submissionQuerySchema,
} from '../../services/dashboardService.js';

export const dashboardRouter = Router();

dashboardRouter.use(['/api/submissions', '/api/stats'], authenticate);

dashboardRouter.get('/api/submissions', async (req, res) => {
  const q = parseOrThrow(submissionQuerySchema, req.query);
  res.json(await getSubmissions(req.auth.tenantId, q));
});

dashboardRouter.get('/api/submissions/:id', async (req, res) => {
  // Shape-check before the query, so a malformed id is a 404 and not a
  // Postgres invalid-input 500.
  if (!isUuid(req.params.id)) throw notFound('Submission not found');
  res.json(await getSubmission(req.auth.tenantId, req.params.id));
});

dashboardRouter.get('/api/stats/overview', async (req, res) => {
  const q = parseOrThrow(statsQuerySchema, req.query);
  res.json(await getOverview(req.auth.tenantId, q));
});
