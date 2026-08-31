import { Router } from 'express';
import { parseOrThrow } from '../../lib/validate.js';
import { clientIp } from '../../lib/net.js';
import { rateLimitByIp, rateLimitByWidget } from '../middleware/rateLimit.js';
import { submissionEnvelopeSchema } from '../../services/submissionSchemas.js';
import { submit } from '../../services/submissionService.js';

export const publicSubmissionsRouter = Router();

const PATH = '/api/public/submissions';

// Order matters and is the design doc's pipeline, top to bottom:
// per-IP limit (cheapest, before any query) → envelope shape → per-widget limit
// → service, which does origin check, spam, field validation, enrichment, store.
publicSubmissionsRouter.post(
  PATH,
  rateLimitByIp,
  (req, res, next) => {
    // Validate the envelope before the per-widget limiter reads widget_id from
    // it, so the limiter can never be keyed on an attacker-shaped value.
    try {
      req.envelope = parseOrThrow(submissionEnvelopeSchema, req.body);
      return next();
    } catch (err) {
      return next(err);
    }
  },
  rateLimitByWidget,
  async (req, res) => {
    const idempotencyKey = req.get('idempotency-key')?.slice(0, 128) || null;

    const result = await submit({
      body: req.envelope,
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
      referer: req.get('referer')?.slice(0, 500) ?? null,
      origin: req.get('origin') ?? null,
      idempotencyKey,
      requestId: req.id,
    });

    res.status(result.status).json(result.body);
  },
);
