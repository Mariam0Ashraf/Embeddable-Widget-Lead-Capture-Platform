import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, query } from '../src/lib/db.js';
import { enrichIp } from '../src/services/geo/geoService.js';
import {
  app,
  createTenant,
  createWidget,
  freshIp,
  jobsFor,
  resetRateLimiters,
  rowById,
  submit,
} from './helpers.js';

let widget;

beforeAll(async () => {
  const tenant = await createTenant();
  widget = await createWidget(tenant.token);
});

beforeEach(() => resetRateLimiters());
afterAll(() => closePool());

// Stand-in providers. Injecting the chain keeps the fallback proof entirely
// deterministic — no network, no third party, no flake.
const up = (name, country) => ({
  name,
  lookup: async () => ({ country, country_code: country.slice(0, 2).toUpperCase(), region: null, city: null, lat: null, lon: null }),
});
const down = (name) => ({
  name,
  lookup: async () => {
    throw new Error(`${name} is unavailable`);
  },
});

describe('geo enrichment fallback chain', () => {
  const PUBLIC_IP = '8.8.8.8';

  it('uses provider A when it answers, and never calls B', async () => {
    const b = down('provider-b');
    const spy = vi.spyOn(b, 'lookup');

    const result = await enrichIp(PUBLIC_IP, { chain: [up('provider-a', 'Germany'), b] });

    expect(result.status).toBe('enriched');
    expect(result.provider).toBe('provider-a');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to provider B when A is down', async () => {
    const result = await enrichIp(PUBLIC_IP, { chain: [down('provider-a'), up('provider-b', 'Portugal')] });

    expect(result.status).toBe('enriched');
    expect(result.provider).toBe('provider-b');
    expect(result.geo.country).toBe('Portugal');
    expect(result.attempts).toEqual([
      { provider: 'provider-a', ok: false, error: 'provider-a is unavailable' },
      { provider: 'provider-b', ok: true },
    ]);
  });

  it('reports unavailable rather than throwing when every provider is down', async () => {
    const result = await enrichIp(PUBLIC_IP, { chain: [down('provider-a'), down('provider-b')] });

    expect(result.status).toBe('unavailable');
    expect(result.geo).toBeNull();
    expect(result.attempts.every((a) => a.ok === false)).toBe(true);
  });

  it('has no throw path at all — a provider that explodes is still just a result', async () => {
    const exploding = {
      name: 'exploding',
      lookup: () => {
        throw new TypeError('undefined is not a function');
      },
    };

    await expect(enrichIp(PUBLIC_IP, { chain: [exploding] })).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('skips private addresses instead of spending provider quota on them', async () => {
    const result = await enrichIp('127.0.0.1', { chain: [up('provider-a', 'Germany')] });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('private_ip');
  });
});

describe('enrichment through the HTTP path', () => {
  // The suite pins GEO_PROVIDER_A_MODE=down and B=mock_ok, so a submission that
  // reaches storage has, by definition, fallen through A to B.
  it('stores a submission enriched by the fallback provider', async () => {
    const res = await submit(widget.public_id, { email: 'geo@example.com' }, { ip: '8.8.8.8' });

    expect(res.status).toBe(201);
    expect(res.body.geo_status).toBe('enriched');
    expect(res.body.geo_provider).toBe('ipapi.co');

    const row = await rowById(res.body.id);
    expect(row.geo_status).toBe('enriched');
    expect(row.geo.country).toBe('Portugal');
  });

  it('still stores the submission when the address cannot be enriched', async () => {
    const res = await submit(widget.public_id, { email: 'private@example.com' }, { ip: '10.0.0.4' });

    expect(res.status).toBe(201);
    const row = await rowById(res.body.id);
    expect(row).not.toBeNull();
    expect(row.geo).toBeNull();
    expect(row.geo_status).toBe('skipped');
  });
});

describe('safe side effects', () => {
  it('writes the outbox job in the same transaction as the submission', async () => {
    const res = await submit(widget.public_id, { email: 'outbox@example.com' }, { ip: freshIp() });
    expect(res.status).toBe(201);

    const jobs = await jobsFor(res.body.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].type).toBe('submission_confirmation');
    expect(jobs[0].payload.to).toBe('outbox@example.com');
  });

  it('delivers the job and marks it done when the transport works', async () => {
    const res = await submit(widget.public_id, { email: 'delivered@example.com' }, { ip: freshIp() });
    const { processDueJobs } = await import('../src/workers/sideEffectWorker.js');

    /*
     * Park every other pending job first.
     *
     * The worker claims the *oldest* due jobs, and by the time this file runs the
     * earlier test files have queued dozens. Raising batchSize only moves the
     * threshold — the test would still be quietly measuring somebody else's job.
     * Narrowing the queue to this one submission is what makes the assertion mean
     * what it says.
     */
    await query("UPDATE side_effect_jobs SET status = 'done' WHERE status = 'pending' AND submission_id <> $1", [
      res.body.id,
    ]);
    await query('UPDATE side_effect_jobs SET next_attempt_at = now() WHERE submission_id = $1', [res.body.id]);

    const outcome = await processDueJobs({ batchSize: 5 });
    expect(outcome.claimed).toBe(1);
    expect(outcome.done).toBe(1);

    const [job] = await jobsFor(res.body.id);
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(1);
  });
});

/*
 * PROBE 5, as a test. The transport is mocked to throw so the failure is a
 * property of the dependency, not of the worker — and the assertion that matters
 * is the one at the end: the lead is still in the database after every retry has
 * been exhausted.
 */
describe('a failing side effect never costs a lead', () => {
  it('stores the submission, retries with backoff, then dead-letters', async () => {
    vi.resetModules();
    vi.doMock('../src/services/sideEffects/transports.js', () => ({
      dispatchSideEffect: vi.fn(async () => {
        throw new Error('SMTP host unreachable');
      }),
    }));

    const { processDueJobs, backoffSeconds } = await import('../src/workers/sideEffectWorker.js');
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);

    const res = await submit(widget.public_id, { email: 'doomed@example.com' }, { ip: freshIp() });
    expect(res.status).toBe(201);
    expect(await rowById(res.body.id)).not.toBeNull();

    // Park every other pending job so this test only observes its own.
    await query('UPDATE side_effect_jobs SET status = $1 WHERE status = $2 AND submission_id <> $3', [
      'done',
      'pending',
      res.body.id,
    ]);

    const maxAttempts = (await jobsFor(res.body.id))[0].max_attempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await query('UPDATE side_effect_jobs SET next_attempt_at = now() WHERE submission_id = $1', [res.body.id]);
      await processDueJobs({ batchSize: 5 });

      const [job] = await jobsFor(res.body.id);
      expect(job.attempts).toBe(attempt);
      expect(job.last_error).toContain('SMTP host unreachable');
      expect(job.status).toBe(attempt < maxAttempts ? 'pending' : 'failed');
    }

    // The whole point.
    const survivor = await rowById(res.body.id);
    expect(survivor).not.toBeNull();
    expect(survivor.data.email).toBe('doomed@example.com');

    vi.doUnmock('../src/services/sideEffects/transports.js');
    vi.resetModules();
  });
});

describe('idempotency', () => {
  it('returns the original row for a retried request instead of storing twice', async () => {
    const key = `idem-${Date.now()}`;
    const ip = freshIp();
    const body = { email: 'once@example.com' };

    const first = await submit(widget.public_id, body, { ip, headers: { 'Idempotency-Key': key } });
    const replay = await submit(widget.public_id, body, { ip, headers: { 'Idempotency-Key': key } });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.idempotent_replay).toBe(true);

    const { rows } = await query('SELECT count(*)::int AS count FROM submissions WHERE idempotency_key = $1', [key]);
    expect(rows[0].count).toBe(1);
  });

  it('scopes the key to the widget, so two widgets can use the same key', async () => {
    const tenant = await createTenant();
    const other = await createWidget(tenant.token, { title: 'Second widget' });
    const key = `shared-${Date.now()}`;

    const a = await submit(widget.public_id, { email: 'a@example.com' }, { ip: freshIp(), headers: { 'Idempotency-Key': key } });
    const b = await submit(other.public_id, { email: 'b@example.com' }, { ip: freshIp(), headers: { 'Idempotency-Key': key } });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });
});
