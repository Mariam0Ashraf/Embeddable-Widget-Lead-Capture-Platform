import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/lib/db.js';
import { app, createTenant, createWidget, freshIp, resetRateLimiters, SITE, submit } from './helpers.js';

let widget;

beforeAll(async () => {
  const tenant = await createTenant();
  widget = await createWidget(tenant.token);
});

beforeEach(() => resetRateLimiters());
afterAll(() => closePool());

describe('CORS on the public submission endpoint', () => {
  it('answers the preflight with the headers a browser needs', async () => {
    const res = await request(app)
      .options('/api/public/submissions')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    expect(res.headers['access-control-max-age']).toBeDefined();
    // The reflected origin makes the response origin-dependent, so caches must key on it.
    expect(res.headers.vary).toBe('Origin');
  });

  it('reflects the origin on a successful submission', async () => {
    const res = await submit(widget.public_id, { email: 'cors@example.com' }, { ip: freshIp() });
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  /*
   * This is the test that earns its keep. If CORS were registered after the body
   * parser, these responses would carry no CORS header, the browser would refuse
   * to expose them, and a correct 413 would show up in the customer's console as
   * "blocked by CORS" — the most misleading failure in the whole system.
   */
  it.each([
    ['malformed JSON', () => request(app).post('/api/public/submissions').set('Origin', SITE).set('Content-Type', 'application/json').send('{"widget_id":')],
    ['oversized payload', () => submit(widget.public_id, { name: 'x'.repeat(40_000) }, { ip: freshIp() })],
  ])('keeps CORS headers on the error response for %s', async (_label, makeRequest) => {
    const res = await makeRequest();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('rejects an origin the widget does not allow, because curl ignores CORS', async () => {
    const res = await submit(
      widget.public_id,
      { email: 'evil@example.com' },
      { ip: freshIp(), origin: 'http://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('validation at the boundary — bad input is 4xx, never 500', () => {
  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/public/submissions')
      .set('Origin', SITE)
      .set('Content-Type', 'application/json')
      .send('{"widget_id":');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('rejects an oversized payload with 413', async () => {
    const res = await submit(widget.public_id, { name: 'x'.repeat(40_000) }, { ip: freshIp() });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('reports every bad field at once rather than one at a time', async () => {
    const res = await submit(
      widget.public_id,
      { email: 'not-an-email', plan: 'enterprise', undeclared: 'x' },
      { ip: freshIp() },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    const fields = res.body.details.map((d) => d.field);
    expect(fields).toContain('data.email');
    expect(fields).toContain('data.plan');
    // An undeclared key is rejected, not silently dropped — a customer should
    // never wonder where a submitted value went.
    expect(fields).toContain('data.undeclared');
  });

  it('rejects a missing required field', async () => {
    const res = await submit(widget.public_id, {}, { ip: freshIp() });
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('data.email');
  });

  it('rejects an unknown widget with 404', async () => {
    const res = await submit('nosuchwidget', { email: 'a@b.co' }, { ip: freshIp() });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown envelope key', async () => {
    const res = await request(app)
      .post('/api/public/submissions')
      .set('Origin', SITE)
      .set('X-Forwarded-For', freshIp())
      .send({ widget_id: widget.public_id, data: { email: 'a@b.co' }, injected: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('stores only declared fields, rebuilt from the widget definition', async () => {
    const res = await submit(
      widget.public_id,
      { email: 'clean@example.com', name: '  Padded  ', plan: 'pro' },
      { ip: freshIp() },
    );
    expect(res.status).toBe(201);

    const { rowById } = await import('./helpers.js');
    const row = await rowById(res.body.id);
    expect(Object.keys(row.data).sort()).toEqual(['email', 'name', 'plan']);
    expect(row.data.name).toBe('Padded'); // trimmed on the way in
  });

  it('never returns a 500 for any of the malformed shapes above', async () => {
    const shapes = [
      { widget_id: widget.public_id, data: 'not-an-object' },
      { widget_id: 123, data: {} },
      { data: { email: 'a@b.co' } },
      {},
      { widget_id: widget.public_id, data: { email: { nested: 'object' } } },
    ];

    for (const body of shapes) {
      const res = await request(app)
        .post('/api/public/submissions')
        .set('Origin', SITE)
        .set('X-Forwarded-For', freshIp())
        .send(body);

      expect(res.status, `body ${JSON.stringify(body)} produced ${res.status}`).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
