import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { query } from '../src/lib/db.js';
import { resetRateLimiters } from '../src/http/middleware/rateLimit.js';

export const app = createApp();
export const SITE = 'http://localhost:5500';

let counter = 0;
const unique = () => `${Date.now()}-${(counter += 1)}`;

/** A fresh tenant with a token. Each test gets its own, so no test can see another's rows. */
export async function createTenant(name = 'Test Co') {
  const email = `t-${unique()}@example.test`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'correct-horse-battery', tenant_name: name });

  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id, email };
}

export const SIGNUP_FIELDS = [
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'name', label: 'Name', type: 'text', required: false, max_length: 80 },
  { name: 'plan', label: 'Plan', type: 'select', required: false, options: ['free', 'pro'] },
];

export async function createWidget(token, overrides = {}) {
  const res = await request(app)
    .post('/api/widgets')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'signup_form',
      title: 'Test widget',
      fields: SIGNUP_FIELDS,
      allowed_origins: [SITE],
      ...overrides,
    });

  if (res.status !== 201) throw new Error(`widget create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * A submission from the demo origin. `ip` is explicit on purpose: the per-IP
 * limiter is shared process state, so a test that wants a clean quota asks for
 * an address no other test uses.
 */
export function submit(widgetPublicId, data, { ip = '203.0.113.1', origin = SITE, headers = {}, extra = {} } = {}) {
  const req = request(app)
    .post('/api/public/submissions')
    .set('X-Forwarded-For', ip)
    .set('Origin', origin);

  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return req.send({ widget_id: widgetPublicId, data, ...extra });
}

/** A distinct IP per call, so quota from one test never leaks into the next. */
let ipCounter = 0;
export const freshIp = () => `198.51.100.${(ipCounter = (ipCounter + 1) % 250) + 1}`;

export const countRows = async (widgetPublicId) => {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM submissions
      WHERE widget_id = (SELECT id FROM widgets WHERE public_id = $1)`,
    [widgetPublicId],
  );
  return rows[0].count;
};

export const rowById = async (id) => {
  const { rows } = await query('SELECT * FROM submissions WHERE id = $1', [id]);
  return rows[0] ?? null;
};

export const jobsFor = async (submissionId) => {
  const { rows } = await query('SELECT * FROM side_effect_jobs WHERE submission_id = $1', [submissionId]);
  return rows;
};

export { resetRateLimiters };
