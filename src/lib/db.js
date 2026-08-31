import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // An idle client blowing up must not take the process down with it.
  logger.error('idle database client error', { error: err.message });
});

export const query = (text, params) => pool.query(text, params);

/**
 * Runs `fn` inside a transaction, handing it a client whose `query` is bound.
 * Commits on success, rolls back on any throw, and always releases the client.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Waits for Postgres to accept connections — the API boots before the DB is ready. */
export async function waitForDatabase({ attempts = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      logger.warn('database not ready, retrying', { attempt, error: err.message });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export const closePool = () => pool.end();
