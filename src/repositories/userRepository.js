import { query } from '../lib/db.js';

export async function createTenantWithUser(client, { tenantName, email, passwordHash }) {
  const { rows: tenantRows } = await client.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
    [tenantName],
  );
  const tenant = tenantRows[0];

  const { rows: userRows } = await client.query(
    `INSERT INTO users (tenant_id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, tenant_id, email, created_at`,
    [tenant.id, email, passwordHash],
  );

  return { tenant, user: userRows[0] };
}

export async function findUserByEmail(email) {
  const { rows } = await query(
    'SELECT id, tenant_id, email, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id) {
  const { rows } = await query('SELECT id, tenant_id, email FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}
