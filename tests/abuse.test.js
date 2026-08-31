import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { app, countRows, createTenant, createWidget, freshIp, resetRateLimiters, submit } from './helpers.js';

let widget;

beforeAll(async () => {
  const tenant = await createTenant();
  widget = await createWidget(tenant.token);
});

beforeEach(() => resetRateLimiters());
afterAll(() => closePool());

describe('rate limiting', () => {
  it('returns 429 once one address exceeds its quota', async () => {
    const ip = freshIp();
    const limit = config.RATE_LIMIT_MAX_PER_IP;
    const statuses = [];

    for (let i = 0; i < limit + 3; i += 1) {
      const res = await submit(widget.public_id, { email: `burst${i}@example.com` }, { ip });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, limit).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(limit).every((s) => s === 429)).toBe(true);
  });

  it('sends Retry-After and the quota headers with the 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < config.RATE_LIMIT_MAX_PER_IP; i += 1) {
      await submit(widget.public_id, { email: `h${i}@example.com` }, { ip });
    }

    const res = await submit(widget.public_id, { email: 'over@example.com' }, { ip });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-limit']).toBe(String(config.RATE_LIMIT_MAX_PER_IP));
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  /*
   * The requirement is not "a flood gets 429" — it is "a flood gets 429 *and the
   * API keeps serving everyone else*". A limiter that shed all load would pass
   * the first assertion and fail the product.
   */
  it('keeps serving legitimate traffic while one address is being refused', async () => {
    const flooder = freshIp();
    for (let i = 0; i < config.RATE_LIMIT_MAX_PER_IP + 2; i += 1) {
      await submit(widget.public_id, { email: `f${i}@example.com` }, { ip: flooder });
    }

    expect((await submit(widget.public_id, { email: 'ok@example.com' }, { ip: freshIp() })).status).toBe(201);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('caps one widget independently of the address it is hit from', async () => {
    const perWidget = config.RATE_LIMIT_MAX_PER_WIDGET;
    let limited = 0;

    // A different IP every time, so only the per-widget limiter can trip.
    for (let i = 0; i < perWidget + 4; i += 1) {
      const res = await submit(widget.public_id, { email: `w${i}@example.com` }, { ip: freshIp() });
      if (res.status === 429) {
        limited += 1;
        expect(res.body.details.scope).toBe('widget');
      }
    }

    expect(limited).toBeGreaterThan(0);
  });
});

describe('spam controls', () => {
  it('drops a submission whose honeypot is filled, and says nothing about why', async () => {
    const before = await countRows(widget.public_id);

    const res = await submit(
      widget.public_id,
      { email: 'bot@spam.test' },
      { ip: freshIp(), extra: { _hp: 'http://buy-cheap.example' } },
    );

    // Indistinguishable from success on purpose: telling the bot which control
    // it tripped is free tuning information for whoever wrote it.
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
    expect(await countRows(widget.public_id)).toBe(before);
  });

  it('drops a submission filled faster than a human could type', async () => {
    const before = await countRows(widget.public_id);

    const res = await submit(
      widget.public_id,
      { email: 'fast@spam.test' },
      { ip: freshIp(), extra: { rendered_at: Date.now() - 50 } },
    );

    expect(res.status).toBe(201);
    expect(await countRows(widget.public_id)).toBe(before);
  });

  it('drops a submission whose render stamp is in the future', async () => {
    const before = await countRows(widget.public_id);
    const res = await submit(
      widget.public_id,
      { email: 'forged@spam.test' },
      { ip: freshIp(), extra: { rendered_at: Date.now() + 60_000 } },
    );

    expect(res.status).toBe(201);
    expect(await countRows(widget.public_id)).toBe(before);
  });

  it('accepts a submission that took a human amount of time', async () => {
    const before = await countRows(widget.public_id);

    const res = await submit(
      widget.public_id,
      { email: 'human@example.com' },
      { ip: freshIp(), extra: { rendered_at: Date.now() - config.SPAM_MIN_FILL_MS - 500, _hp: '' } },
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(await countRows(widget.public_id)).toBe(before + 1);
  });

  /*
   * Without this test the two above would still pass if the endpoint simply
   * stored nothing at all. It pins down that the spam path is what differs, not
   * the whole write path.
   */
  it('accepts an identical submission with no honeypot value', async () => {
    const before = await countRows(widget.public_id);
    const res = await submit(widget.public_id, { email: 'nohp@example.com' }, { ip: freshIp() });

    expect(res.status).toBe(201);
    expect(await countRows(widget.public_id)).toBe(before + 1);
  });
});
