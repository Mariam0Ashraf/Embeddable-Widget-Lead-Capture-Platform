import pg from 'pg';
import { execFileSync } from 'node:child_process';

/**
 * Creates the test database if it does not exist, then migrates it.
 *
 * The suite runs against a *separate* database, not the development one. Tests
 * that truncate tables should never be one typo away from deleting the demo data
 * a reviewer is looking at.
 */
export default async function setup() {
  const url = new URL(
    process.env.TEST_DATABASE_URL || 'postgres://widget:widget@localhost:5433/widgets_test',
  );
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${url.host}. Start it with \`docker compose up -d db\`.\n  ${err.message}`,
    );
  }

  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  // CREATE DATABASE cannot be parameterised, so the identifier is quoted rather
  // than interpolated raw. It comes from our own config, not from user input.
  if (rowCount === 0) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await admin.end();

  execFileSync(process.execPath, ['scripts/migrate.js'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url.toString(), LOG_LEVEL: 'silent' },
  });

  /*
   * Start every run from an empty database.
   *
   * Without this the suite is reproducible exactly once. Rows accumulate across
   * runs, and the outbox tests — which claim the *oldest* due jobs — start
   * picking up leftovers from previous runs instead of their own job. That is a
   * test failing for a reason that has nothing to do with the code, which is the
   * worst kind of red.
   */
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query('TRUNCATE side_effect_jobs, submissions, widgets, users, tenants CASCADE');
  await db.end();
}
