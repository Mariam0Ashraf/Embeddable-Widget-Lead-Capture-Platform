import { query } from '../lib/db.js';

// Every function in this file that touches a tenant's data takes tenantId as a
// required argument and puts it in the WHERE clause. There is deliberately no
// "find by id, then check the owner" path — that is the one people forget.

const COLUMNS = `id, public_id, tenant_id, type, title, description, fields,
                 button_text, display, allowed_origins, config_version, is_active,
                 created_at, updated_at`;

export async function insertWidget({
  publicId,
  tenantId,
  type,
  title,
  description,
  fields,
  buttonText,
  display,
  allowedOrigins,
  isActive,
}) {
  const { rows } = await query(
    `INSERT INTO widgets (public_id, tenant_id, type, title, description, fields,
                          button_text, display, allowed_origins, is_active)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[], $10)
     RETURNING ${COLUMNS}`,
    [
      publicId,
      tenantId,
      type,
      title,
      description,
      JSON.stringify(fields),
      buttonText,
      JSON.stringify(display),
      allowedOrigins,
      isActive,
    ],
  );
  return rows[0];
}

export async function listWidgets(tenantId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM widgets
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows;
}

export async function countWidgets(tenantId) {
  const { rows } = await query('SELECT count(*)::int AS count FROM widgets WHERE tenant_id = $1', [
    tenantId,
  ]);
  return rows[0].count;
}

export async function findWidgetById(tenantId, id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM widgets WHERE id = $1 AND tenant_id = $2`, [
    id,
    tenantId,
  ]);
  return rows[0] ?? null;
}

/** Public lookup — no tenant scope by design; this is what the internet reads. */
export async function findWidgetByPublicId(publicId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM widgets WHERE public_id = $1`, [publicId]);
  return rows[0] ?? null;
}

const UPDATABLE = {
  type: (v) => [v, 'text'],
  title: (v) => [v, 'text'],
  description: (v) => [v, 'text'],
  fields: (v) => [JSON.stringify(v), 'jsonb'],
  button_text: (v) => [v, 'text'],
  display: (v) => [JSON.stringify(v), 'jsonb'],
  allowed_origins: (v) => [v, 'text[]'],
  is_active: (v) => [v, 'boolean'],
};

/**
 * Patches only the supplied columns. `bumpVersion` advances config_version so
 * caches serving the public config expire onto the new content.
 */
export async function updateWidget(tenantId, id, patch, { bumpVersion = false } = {}) {
  const assignments = [];
  const values = [];

  for (const [column, transform] of Object.entries(UPDATABLE)) {
    if (!(column in patch)) continue;
    const [value, castType] = transform(patch[column]);
    values.push(value);
    assignments.push(`${column} = $${values.length}::${castType}`);
  }

  if (assignments.length === 0) return findWidgetById(tenantId, id);

  assignments.push('updated_at = now()');
  if (bumpVersion) assignments.push('config_version = config_version + 1');

  values.push(id, tenantId);
  const { rows } = await query(
    `UPDATE widgets SET ${assignments.join(', ')}
     WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
     RETURNING ${COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

export async function deleteWidget(tenantId, id) {
  const { rowCount } = await query('DELETE FROM widgets WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return rowCount > 0;
}
