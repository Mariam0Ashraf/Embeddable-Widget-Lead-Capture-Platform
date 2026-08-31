import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { forbidden, notFound } from '../lib/errors.js';
import { originAllowed } from '../lib/origins.js';
import { findWidgetByPublicId } from '../repositories/widgetRepository.js';
import {
  findByIdempotencyKey,
  insertSubmissionWithJob,
} from '../repositories/submissionRepository.js';
import { enrichIp } from './geo/geoService.js';
import { detectSpam } from './spamService.js';
import { validateSubmissionData } from './submissionSchemas.js';

/** The recipient for a confirmation, if this widget collects one. */
function recipientFrom(widget, data) {
  const emailField = widget.fields.find((f) => f.type === 'email');
  return emailField ? (data[emailField.name] ?? null) : null;
}

const present = (submission) => ({
  id: submission.id,
  widget_id: submission.widget_id,
  created_at: submission.created_at,
  geo_status: submission.geo_status,
});

/**
 * The whole visitor path, in the order the design doc lays out. Each step either
 * throws a typed 4xx or hands the next one clean data. Nothing here knows what a
 * request object is — the route hands it primitives.
 */
export async function submit({ body, ip, userAgent, referer, origin, idempotencyKey, requestId }) {
  const widget = await findWidgetByPublicId(body.widget_id);
  if (!widget || !widget.is_active) throw notFound('Widget not found');

  // The allow-list is checked server-side as well as via CORS headers. CORS is a
  // browser courtesy; curl ignores it entirely, so it is not a control on its own.
  if (!originAllowed(origin, widget.allowed_origins)) {
    logger.warn('submission rejected: origin not allowed', {
      request_id: requestId,
      widget: widget.public_id,
      origin,
    });
    throw forbidden('This widget is not permitted to be embedded on that origin');
  }

  const spam = detectSpam(body);
  if (spam.spam) {
    logger.warn('submission blocked as spam', {
      request_id: requestId,
      widget: widget.public_id,
      reason: spam.reason,
      elapsed_ms: spam.elapsed_ms,
    });
    // Answered exactly like a success, with nothing stored. Telling the bot what
    // it tripped is free tuning information for whoever wrote it.
    return {
      status: 201,
      body: { id: randomUUID(), status: 'received' },
      stored: false,
      spamReason: spam.reason,
    };
  }

  // Throws a 400 listing every bad field at once.
  const data = validateSubmissionData(widget.fields, body.data);

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(widget.id, idempotencyKey);
    if (existing) {
      logger.info('idempotent replay', { request_id: requestId, submission_id: existing.id });
      return { status: 200, body: { ...present(existing), idempotent_replay: true }, stored: false };
    }
  }

  // Never throws — worst case it reports 'unavailable' and we store without geo.
  const enrichment = await enrichIp(ip);

  let submission;
  try {
    submission = await insertSubmissionWithJob({
      widgetId: widget.id,
      tenantId: widget.tenant_id,
      data,
      ip,
      userAgent,
      referer,
      origin,
      geo: enrichment.geo,
      geoProvider: enrichment.provider,
      geoStatus: enrichment.status,
      idempotencyKey: idempotencyKey ?? null,
      job: {
        type: 'submission_confirmation',
        maxAttempts: config.SIDE_EFFECT_MAX_ATTEMPTS,
        payload: {
          widget_public_id: widget.public_id,
          widget_title: widget.title,
          to: recipientFrom(widget, data),
        },
      },
    });
  } catch (err) {
    // Two identical retries can arrive close enough together that both pass the
    // lookup above. The unique index settles it; return the row that won.
    if (err.code === '23505' && idempotencyKey) {
      const existing = await findByIdempotencyKey(widget.id, idempotencyKey);
      if (existing) {
        return { status: 200, body: { ...present(existing), idempotent_replay: true }, stored: false };
      }
    }
    throw err;
  }

  logger.info('submission stored', {
    request_id: requestId,
    submission_id: submission.id,
    widget: widget.public_id,
    geo_status: enrichment.status,
    geo_provider: enrichment.provider,
  });

  return {
    status: 201,
    body: {
      ...present(submission),
      geo: enrichment.geo,
      geo_provider: enrichment.provider,
    },
    stored: true,
    widget,
  };
}
