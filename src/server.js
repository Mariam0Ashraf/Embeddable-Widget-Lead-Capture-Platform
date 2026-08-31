import { createApp } from './http/app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { waitForDatabase, closePool } from './lib/db.js';
import { startSideEffectWorker } from './workers/sideEffectWorker.js';

const app = createApp();

await waitForDatabase();

// The outbox drainer. Started after the database is reachable so its first tick
// does not race the connection.
const worker = config.WORKER_ENABLED ? startSideEffectWorker() : null;

const server = app.listen(config.PORT, () => {
  logger.info('api listening', {
    port: config.PORT,
    env: config.NODE_ENV,
    base_url: config.PUBLIC_BASE_URL,
  });
});

async function shutdown(signal) {
  logger.info('shutting down', { signal });
  worker?.stop();
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
  // Don't let a hung connection hold the process open forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
