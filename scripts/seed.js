#!/usr/bin/env node
/*
 * Demo data, plus the one manual step nobody should have to do by hand.
 *
 * A stranger cloning this repo needs a widget that exists and a customer page
 * whose <script> tag points at it. So the seed creates the tenant and the
 * widgets, then writes public/site/index.html from the template with the real
 * public id baked in. Re-running it is safe: the demo tenant is reused.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../src/lib/config.js';
import { closePool, query, waitForDatabase, withTransaction } from '../src/lib/db.js';
import { publicId as generatePublicId } from '../src/lib/ids.js';
import { buildEmbed } from '../src/services/widgetService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEMO_EMAIL = 'owner@demo.test';
const DEMO_PASSWORD = 'demo-password-123';

const WIDGETS = [
  {
    key: 'newsletter',
    type: 'signup_form',
    title: 'Join the roast list',
    description: 'One email when a new batch lands. Nothing else, ever.',
    button_text: 'Subscribe',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@example.com' },
      { name: 'name', label: 'First name', type: 'text', required: false, max_length: 80 },
      { name: 'roast', label: 'Preferred roast', type: 'select', required: false, options: ['light', 'medium', 'dark'] },
      { name: 'consent', label: 'Email me about new batches', type: 'checkbox', required: false },
    ],
    display: { position: 'inline', theme: 'light', delay_ms: 0, success_message: 'You are on the list. See you Tuesday.' },
  },
  {
    key: 'contact',
    type: 'contact_form',
    title: 'Talk to us',
    description: 'Wholesale, faults, or feedback.',
    button_text: 'Send message',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'phone', label: 'Phone', type: 'tel', required: false },
      { name: 'message', label: 'Message', type: 'textarea', required: true, max_length: 2000 },
    ],
    display: { position: 'bottom-right', theme: 'dark', delay_ms: 0, success_message: 'Message received. We reply within a day.' },
  },
];

async function ensureTenant() {
  const existing = await query(
    'SELECT u.id AS user_id, u.tenant_id FROM users u WHERE lower(u.email) = lower($1)',
    [DEMO_EMAIL],
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, config.BCRYPT_ROUNDS);
  return withTransaction(async (client) => {
    const tenant = await client.query(
      "INSERT INTO tenants (name) VALUES ('Northwind Coffee') RETURNING id",
    );
    const user = await client.query(
      'INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id AS user_id, tenant_id',
      [tenant.rows[0].id, DEMO_EMAIL, passwordHash],
    );
    return user.rows[0];
  });
}

async function ensureWidget(tenantId, spec) {
  const existing = await query(
    'SELECT * FROM widgets WHERE tenant_id = $1 AND title = $2 LIMIT 1',
    [tenantId, spec.title],
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const { rows } = await query(
    `INSERT INTO widgets (public_id, tenant_id, type, title, description, fields,
                          button_text, display, allowed_origins, is_active)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[], true)
     RETURNING *`,
    [
      generatePublicId(),
      tenantId,
      spec.type,
      spec.title,
      spec.description,
      JSON.stringify(spec.fields),
      spec.button_text,
      JSON.stringify(spec.display),
      // Locked to the demo origin, so the seeded widgets also demonstrate the
      // allow-list rejecting anywhere else.
      [config.DEMO_SITE_ORIGIN],
    ],
  );
  return rows[0];
}

async function writeDemoSite(publicId) {
  const templatePath = path.join(root, 'public', 'site', 'index.template.html');
  const outputPath = path.join(root, 'public', 'site', 'index.html');
  const template = await readFile(templatePath, 'utf8');
  const html = template
    .replaceAll('REPLACE_WITH_PUBLIC_ID', publicId)
    .replaceAll('http://localhost:3000', config.PUBLIC_BASE_URL.replace(/\/+$/, ''));
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}

async function run() {
  await waitForDatabase();
  const { tenant_id: tenantId } = await ensureTenant();

  const created = [];
  for (const spec of WIDGETS) {
    created.push(await ensureWidget(tenantId, spec));
  }

  const primary = created[0];
  const outputPath = await writeDemoSite(primary.public_id);

  const line = (s) => process.stdout.write(s + '\n');
  line('');
  line('  Seed complete.');
  line('');
  line('  Owner login');
  line('    email    ' + DEMO_EMAIL);
  line('    password ' + DEMO_PASSWORD);
  line('');
  line('  Widgets');
  for (const w of created) {
    line('    ' + w.title.padEnd(20) + ' public_id=' + w.public_id + '  (' + w.type + ')');
  }
  line('');
  line('  Embed snippet for the demo page');
  line('    ' + buildEmbed(primary).snippet);
  line('');
  line('  Customer test site written to ' + path.relative(root, outputPath));
  line('    open ' + config.DEMO_SITE_ORIGIN + '  (a different origin to ' + config.PUBLIC_BASE_URL + ')');
  line('');
}

run()
  .then(() => closePool())
  .catch(async (err) => {
    process.stderr.write('seed failed: ' + err.message + '\n');
    await closePool().catch(() => {});
    process.exit(1);
  });
