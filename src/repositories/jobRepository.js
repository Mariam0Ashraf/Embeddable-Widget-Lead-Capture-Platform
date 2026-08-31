import { query } from '../lib/db.js';

/**
 * Claims up to `batchSize` due jobs and marks them in-flight in one statement.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run in more than one
 * process: two workers claim disjoint rows instead of both grabbing the same job
 * and sending the customer two emails.
 */
export async function claimDueJobs(batchSize = 5) {
  const { rows } = await query(
    `UPDATE side_effect_jobs
        SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM side_effect_jobs
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, submission_id, type, payload, attempts, max_attempts`,
    [batchSize],
  );
  return rows;
}

export async function markJobDone(id) {
  await query(
    `UPDATE side_effect_jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** Schedules a retry `delaySeconds` from now, keeping the failure on the row. */
export async function markJobRetry(id, error, delaySeconds) {
  await query(
    `UPDATE side_effect_jobs
        SET status = 'pending',
            last_error = $2,
            next_attempt_at = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 500), delaySeconds],
  );
}

export async function markJobFailed(id, error) {
  await query(
    `UPDATE side_effect_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

export async function jobsForSubmission(submissionId) {
  const { rows } = await query(
    `SELECT id, type, status, attempts, max_attempts, last_error, next_attempt_at
       FROM side_effect_jobs WHERE submission_id = $1 ORDER BY created_at`,
    [submissionId],
  );
  return rows;
}
