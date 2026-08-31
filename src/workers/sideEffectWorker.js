import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import {
  claimDueJobs,
  markJobDone,
  markJobFailed,
  markJobRetry,
} from '../repositories/jobRepository.js';
import { dispatchSideEffect } from '../services/sideEffects/transports.js';

/**
 * Drains the side-effect outbox off the request path.
 *
 * This is the background job the shared requirements ask for, and it is also
 * how "a failing confirmation email must not block the submission" is satisfied
 * structurally rather than by remembering to write a try/catch: by the time this
 * runs, the visitor's 201 was sent minutes ago.
 */

/** Exponential backoff with a ceiling: 2s, 4s, 8s … capped at 5 minutes. */
export const backoffSeconds = (attempt) => Math.min(2 ** attempt, 300);

export async function processDueJobs({ batchSize = 5 } = {}) {
  const jobs = await claimDueJobs(batchSize);
  const outcome = { claimed: jobs.length, done: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    try {
      const result = await dispatchSideEffect(job.payload);
      await markJobDone(job.id);
      outcome.done += 1;
      logger.info('side effect delivered', {
        job_id: job.id,
        submission_id: job.submission_id,
        attempts: job.attempts,
        ...result,
      });
    } catch (err) {
      if (job.attempts >= job.max_attempts) {
        await markJobFailed(job.id, err.message);
        outcome.failed += 1;
        // The failure alert: a dead-lettered job is an operator problem, so it
        // is logged at error level with everything needed to replay it by hand.
        logger.error('side effect dead-lettered — manual follow-up required', {
          alert: 'side_effect_dead_letter',
          job_id: job.id,
          submission_id: job.submission_id,
          type: job.type,
          attempts: job.attempts,
          error: err.message,
        });
      } else {
        const delay = backoffSeconds(job.attempts);
        await markJobRetry(job.id, err.message, delay);
        outcome.retried += 1;
        logger.warn('side effect failed, retry scheduled', {
          job_id: job.id,
          submission_id: job.submission_id,
          attempt: job.attempts,
          of: job.max_attempts,
          retry_in_s: delay,
          error: err.message,
        });
      }
    }
  }

  return outcome;
}

export function startSideEffectWorker({ intervalMs = config.WORKER_POLL_MS } = {}) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    // Never let two ticks overlap; a slow SMTP host would otherwise pile up.
    if (running || stopped) return;
    running = true;
    try {
      await processDueJobs();
    } catch (err) {
      // The worker loop itself must never die — a crash here silently stops
      // every confirmation email in the system.
      logger.error('side effect worker tick failed', { error: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  logger.info('side effect worker started', {
    interval_ms: intervalMs,
    transport: config.SIDE_EFFECT_TRANSPORT,
  });

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
