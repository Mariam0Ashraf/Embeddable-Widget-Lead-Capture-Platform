import { query } from '../lib/db.js';

/*
 * Every statement in this file starts its WHERE clause with `s.tenant_id = $1`.
 * That is not a convention, it is the isolation boundary: `tenant_id` is carried
 * on the submission row precisely so no dashboard query has to join through
 * widgets to know who owns a lead, and so no aggregate can accidentally count
 * across tenants.
 */

/**
 * Builds the shared filter fragment. Values go in as bound parameters — the only
 * thing interpolated into the SQL string is a positional placeholder number.
 */
function filters(tenantId, { widgetId, from, to }) {
  const values = [tenantId];
  const clauses = ['s.tenant_id = $1'];

  if (widgetId) {
    values.push(widgetId);
    clauses.push(`s.widget_id = $${values.length}`);
  }
  if (from) {
    values.push(from);
    clauses.push(`s.created_at >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`s.created_at <= $${values.length}`);
  }

  return { where: clauses.join(' AND '), values };
}

const SUBMISSION_COLUMNS = `s.id, s.widget_id, w.public_id AS widget_public_id, w.title AS widget_title,
                            s.data, host(s.ip) AS ip, s.user_agent, s.referer, s.origin,
                            s.geo, s.geo_provider, s.geo_status, s.created_at`;

export async function listSubmissions(tenantId, options) {
  const { where, values } = filters(tenantId, options);
  values.push(options.limit, options.offset);

  const { rows } = await query(
    `SELECT ${SUBMISSION_COLUMNS}
       FROM submissions s
       JOIN widgets w ON w.id = s.widget_id
      WHERE ${where}
      ORDER BY s.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return rows;
}

export async function countSubmissions(tenantId, options) {
  const { where, values } = filters(tenantId, options);
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM submissions s WHERE ${where}`,
    values,
  );
  return rows[0].count;
}

export async function findSubmission(tenantId, id) {
  const { rows } = await query(
    `SELECT ${SUBMISSION_COLUMNS}
       FROM submissions s
       JOIN widgets w ON w.id = s.widget_id
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/** Submissions per day, zero-filled so a quiet day is a 0 rather than a gap. */
export async function countsByDay(tenantId, options, days) {
  const { where, values } = filters(tenantId, options);
  values.push(days);
  const { rows } = await query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('day', now()) - make_interval(days => $${values.length} - 1),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day
     )
     SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
            count(s.id)::int AS count
       FROM span
       LEFT JOIN submissions s
         ON date_trunc('day', s.created_at) = span.day
        AND ${where}
      GROUP BY span.day
      ORDER BY span.day`,
    values,
  );
  return rows;
}

/** Per-widget totals. Every widget appears, including ones with no leads yet. */
export async function countsByWidget(tenantId, options) {
  const { where, values } = filters(tenantId, options);
  const { rows } = await query(
    `SELECT w.id AS widget_id, w.public_id, w.title, w.type, w.is_active,
            count(s.id)::int AS count,
            max(s.created_at) AS last_submission_at
       FROM widgets w
       LEFT JOIN submissions s ON s.widget_id = w.id AND ${where}
      WHERE w.tenant_id = $1
      GROUP BY w.id
      ORDER BY count DESC, w.created_at DESC`,
    values,
  );
  return rows;
}

/**
 * Geo breakdown. Rows whose enrichment failed are reported as `unknown` rather
 * than dropped — hiding them would quietly overstate how well enrichment works.
 */
export async function countsByCountry(tenantId, options, limit) {
  const { where, values } = filters(tenantId, options);
  values.push(limit);
  const { rows } = await query(
    `SELECT coalesce(s.geo->>'country_code', 'unknown') AS country_code,
            coalesce(s.geo->>'country', 'Unknown') AS country,
            count(*)::int AS count
       FROM submissions s
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY count DESC, country
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

/** How often enrichment actually worked, and which provider carried the load. */
export async function enrichmentBreakdown(tenantId, options) {
  const { where, values } = filters(tenantId, options);
  const { rows } = await query(
    `SELECT s.geo_status, coalesce(s.geo_provider, 'none') AS provider, count(*)::int AS count
       FROM submissions s
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY count DESC`,
    values,
  );
  return rows;
}

/**
 * Outbox health for this tenant. A growing `failed` count is the signal that
 * confirmations are being dead-lettered and somebody needs to look.
 */
export async function sideEffectBreakdown(tenantId, options) {
  const { where, values } = filters(tenantId, options);
  const { rows } = await query(
    `SELECT j.status, count(*)::int AS count
       FROM side_effect_jobs j
       JOIN submissions s ON s.id = j.submission_id
      WHERE ${where}
      GROUP BY j.status
      ORDER BY count DESC`,
    values,
  );
  return rows;
}
