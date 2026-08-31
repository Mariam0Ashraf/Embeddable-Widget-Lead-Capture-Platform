import { query, withTransaction } from '../lib/db.js';

const COLUMNS = `id, widget_id, tenant_id, data, host(ip) AS ip, user_agent, referer,
                 origin, geo, geo_provider, geo_status, idempotency_key, created_at`;

/**
 * Writes the submission and its outbox job in one transaction. Either the lead
 * is stored *and* the follow-up is scheduled, or neither happened — there is no
 * state where we keep a lead and silently forget to email them.
 */
export async function insertSubmissionWithJob({
  widgetId,
  tenantId,
  data,
  ip,
  userAgent,
  referer,
  origin,
  geo,
  geoProvider,
  geoStatus,
  idempotencyKey,
  job,
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO submissions (widget_id, tenant_id, data, ip, user_agent, referer,
                                origin, geo, geo_provider, geo_status, idempotency_key)
       VALUES ($1, $2, $3::jsonb, $4::inet, $5, $6, $7, $8::jsonb, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [
        widgetId,
        tenantId,
        JSON.stringify(data),
        ip,
        userAgent,
        referer,
        origin,
        geo ? JSON.stringify(geo) : null,
        geoProvider,
        geoStatus,
        idempotencyKey,
      ],
    );
    const submission = rows[0];

    await client.query(
      `INSERT INTO side_effect_jobs (submission_id, type, payload, max_attempts)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [submission.id, job.type, JSON.stringify(job.payload), job.maxAttempts],
    );

    return submission;
  });
}

export async function findByIdempotencyKey(widgetId, key) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM submissions WHERE widget_id = $1 AND idempotency_key = $2`,
    [widgetId, key],
  );
  return rows[0] ?? null;
}

export async function countForWidget(widgetId) {
  const { rows } = await query('SELECT count(*)::int AS count FROM submissions WHERE widget_id = $1', [
    widgetId,
  ]);
  return rows[0].count;
}
