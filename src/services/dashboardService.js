import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import {
  countsByCountry,
  countsByDay,
  countsByWidget,
  countSubmissions,
  enrichmentBreakdown,
  findSubmission,
  listSubmissions,
  sideEffectBreakdown,
} from '../repositories/dashboardRepository.js';

export const submissionQuerySchema = z
  .object({
    widget_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'widget_id must be a UUID').optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });

export const statsQuerySchema = z
  .object({
    widget_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'widget_id must be a UUID').optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
    countries: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });

const toOptions = (q) => ({ widgetId: q.widget_id, from: q.from, to: q.to });

export async function getSubmissions(tenantId, q) {
  const options = { ...toOptions(q), limit: q.limit, offset: q.offset };

  // Both statements are tenant-scoped, so the total can never describe more rows
  // than the page could ever show.
  const [data, total] = await Promise.all([
    listSubmissions(tenantId, options),
    countSubmissions(tenantId, options),
  ]);

  return {
    data,
    pagination: {
      total,
      limit: q.limit,
      offset: q.offset,
      has_more: q.offset + data.length < total,
    },
  };
}

export async function getSubmission(tenantId, id) {
  const submission = await findSubmission(tenantId, id);
  // 404 rather than 403 for another tenant's id, for the same reason as widgets:
  // a 403 confirms the row exists.
  if (!submission) throw notFound('Submission not found');
  return submission;
}

export async function getOverview(tenantId, q) {
  const options = toOptions(q);

  const [total, byDay, byWidget, byCountry, enrichment, sideEffects] = await Promise.all([
    countSubmissions(tenantId, options),
    countsByDay(tenantId, options, q.days),
    countsByWidget(tenantId, options),
    countsByCountry(tenantId, options, q.countries),
    enrichmentBreakdown(tenantId, options),
    sideEffectBreakdown(tenantId, options),
  ]);

  const enriched = enrichment
    .filter((row) => row.geo_status === 'enriched')
    .reduce((sum, row) => sum + row.count, 0);

  return {
    range: {
      from: q.from ?? null,
      to: q.to ?? null,
      days: q.days,
      widget_id: q.widget_id ?? null,
    },
    totals: {
      submissions: total,
      widgets: byWidget.length,
      enriched,
      // Guard the divide: a tenant with no submissions yet is 0%, not NaN.
      enrichment_rate: total === 0 ? 0 : Math.round((enriched / total) * 1000) / 10,
    },
    by_day: byDay,
    by_widget: byWidget,
    by_country: byCountry,
    by_enrichment: enrichment,
    side_effects: sideEffects,
  };
}
