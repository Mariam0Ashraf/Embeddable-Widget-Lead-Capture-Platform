import { config } from '../lib/config.js';
import { HONEYPOT_FIELD } from './submissionSchemas.js';

/**
 * Two cheap, no-dependency spam controls. Neither tells the bot what it tripped:
 * the caller answers a blocked submission exactly like an accepted one.
 *
 * 1. Honeypot — a hidden field a human never sees and a form-filling bot always
 *    completes.
 * 2. Fill-time heuristic — the bundle stamps `rendered_at` when it draws the
 *    form. A human takes seconds; a script posts in milliseconds.
 *
 * The heuristic only applies when `rendered_at` is present and sane. A missing
 * stamp is not treated as spam, because legitimate server-to-server callers
 * (and the reviewer's curl) have no reason to send one.
 */
export function detectSpam(body) {
  const honeypot = body[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return { spam: true, reason: 'honeypot_filled' };
  }

  if (typeof body.rendered_at === 'number') {
    const elapsed = Date.now() - body.rendered_at;
    // A stamp from the future, or from before the page could plausibly have
    // loaded, is a forged value — treat it as a bot rather than trusting it.
    if (elapsed < 0) return { spam: true, reason: 'rendered_at_in_future' };
    if (elapsed < config.SPAM_MIN_FILL_MS) {
      return { spam: true, reason: 'submitted_too_fast', elapsed_ms: elapsed };
    }
  }

  return { spam: false, reason: null };
}
