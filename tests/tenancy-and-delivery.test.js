import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { bundleVersion } from '../src/services/widgetAssetService.js';
import { app, createTenant, createWidget, freshIp, resetRateLimiters, SITE, submit } from './helpers.js';

let alice;
let bob;
let aliceWidget;
let aliceSubmissionId;

beforeAll(async () => {
  alice = await createTenant('Alice Ltd');
  bob = await createTenant('Bob Inc');
  aliceWidget = await createWidget(alice.token);

  const res = await submit(aliceWidget.public_id, { email: 'lead@example.com' }, { ip: freshIp() });
  aliceSubmissionId = res.body.id;
});

beforeEach(() => resetRateLimiters());
afterAll(() => closePool());

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['a garbage token', 'Bearer not.a.jwt'],
    ['the wrong scheme', 'Basic abc123'],
  ])('rejects %s with 401', async (_label, header) => {
    const req = request(app).get('/api/widgets');
    if (header) req.set('Authorization', header);
    const res = await req;
    expect(res.status).toBe(401);
  });

  it('does not reveal whether an email is registered', async () => {
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.test', password: 'whatever12' });
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: alice.email, password: 'wrongwrong' });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknown.body.message).toBe(wrongPassword.body.message);
  });
});

/*
 * The isolation boundary. Bob holds a perfectly valid token throughout — the
 * question is never "is he authenticated", it is "can a valid caller reach rows
 * that are not his".
 */
describe('tenant isolation', () => {
  it('hides another tenant widget behind a 404, not a 403', async () => {
    const res = await request(app).get(`/api/widgets/${aliceWidget.id}`).set(auth(bob.token));
    // A 403 would confirm the widget exists, which is itself a leak.
    expect(res.status).toBe(404);
  });

  it.each([
    ['read', (id, token) => request(app).get(`/api/widgets/${id}`).set(auth(token))],
    ['update', (id, token) => request(app).patch(`/api/widgets/${id}`).set(auth(token)).send({ title: 'pwned' })],
    ['delete', (id, token) => request(app).delete(`/api/widgets/${id}`).set(auth(token))],
  ])('refuses a cross-tenant %s', async (_label, makeRequest) => {
    expect((await makeRequest(aliceWidget.id, bob.token)).status).toBe(404);
  });

  it('leaves the widget untouched after a failed cross-tenant update', async () => {
    await request(app).patch(`/api/widgets/${aliceWidget.id}`).set(auth(bob.token)).send({ title: 'pwned' });
    const res = await request(app).get(`/api/widgets/${aliceWidget.id}`).set(auth(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test widget');
  });

  it('scopes widget and submission listings to the caller', async () => {
    const bobWidgets = await request(app).get('/api/widgets').set(auth(bob.token));
    const bobSubs = await request(app).get('/api/submissions').set(auth(bob.token));

    expect(bobWidgets.body.pagination.total).toBe(0);
    expect(bobSubs.body.pagination.total).toBe(0);
    expect((await request(app).get('/api/widgets').set(auth(alice.token))).body.pagination.total).toBeGreaterThan(0);
  });

  it('refuses to read another tenant submission by id', async () => {
    expect((await request(app).get(`/api/submissions/${aliceSubmissionId}`).set(auth(bob.token))).status).toBe(404);
    expect((await request(app).get(`/api/submissions/${aliceSubmissionId}`).set(auth(alice.token))).status).toBe(200);
  });

  /*
   * The sharpest version of the question: Bob supplies Alice's widget id as an
   * explicit filter. Because every dashboard query begins with `tenant_id = $1`,
   * the filter can only ever narrow Bob's own rows.
   */
  it('cannot be widened by passing another tenant widget id as a filter', async () => {
    const res = await request(app).get(`/api/submissions?widget_id=${aliceWidget.id}`).set(auth(bob.token));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);
  });

  it('reports zeroed stats rather than another tenant totals', async () => {
    const res = await request(app).get('/api/stats/overview').set(auth(bob.token));
    expect(res.status).toBe(200);
    expect(res.body.totals.submissions).toBe(0);
    // A tenant with no submissions must see 0%, not NaN%.
    expect(res.body.totals.enrichment_rate).toBe(0);
  });

  it('answers a malformed id with 404 rather than letting Postgres raise a 500', async () => {
    expect((await request(app).get('/api/widgets/not-a-uuid').set(auth(alice.token))).status).toBe(404);
    expect((await request(app).get('/api/submissions/not-a-uuid').set(auth(alice.token))).status).toBe(404);
  });
});

describe('widget delivery and caching', () => {
  it('serves the loader with a short cache and the current bundle URL', async () => {
    const res = await request(app).get(`/widget.js?id=${aliceWidget.public_id}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toBe(`public, max-age=${config.LOADER_CACHE_MAX_AGE}`);
    expect(res.text).toContain(`/static/widget.${bundleVersion}.js`);
    expect(res.text).toContain(aliceWidget.public_id);
  });

  it('404s the loader for a widget that does not exist', async () => {
    expect((await request(app).get('/widget.js?id=nosuchwidget')).status).toBe(404);
    expect((await request(app).get('/widget.js')).status).toBe(404);
  });

  it('serves the current bundle as immutable, because the URL carries its hash', async () => {
    const res = await request(app).get(`/static/widget.${bundleVersion}.js`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain(`max-age=${config.BUNDLE_CACHE_MAX_AGE}`);
  });

  it('serves current code with no-cache for a stale version, rather than 404', async () => {
    // A loader cached just before a release still asks for the old URL. A 404
    // there is a customer's form silently vanishing.
    const res = await request(app).get('/static/widget.v0-deadbeef.js');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-widget-bundle']).toBe(bundleVersion);
  });

  it('serves the public config with a max-age and an ETag', async () => {
    const res = await request(app)
      .get(`/api/public/widgets/${aliceWidget.public_id}/config`)
      .set('Origin', SITE);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${config.CONFIG_CACHE_MAX_AGE}`);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers a revalidating request with 304 and no body', async () => {
    const first = await request(app).get(`/api/public/widgets/${aliceWidget.public_id}/config`);
    const second = await request(app)
      .get(`/api/public/widgets/${aliceWidget.public_id}/config`)
      .set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text).toBeFalsy();
  });

  it('rolls the ETag over when the owner edits the widget', async () => {
    const before = (await request(app).get(`/api/public/widgets/${aliceWidget.public_id}/config`)).headers.etag;

    await request(app)
      .patch(`/api/widgets/${aliceWidget.id}`)
      .set(auth(alice.token))
      .send({ button_text: 'Join now' });

    const after = await request(app).get(`/api/public/widgets/${aliceWidget.public_id}/config`);
    expect(after.headers.etag).not.toBe(before);

    // The stale validator must stop matching, or caches would serve old config.
    const stale = await request(app)
      .get(`/api/public/widgets/${aliceWidget.public_id}/config`)
      .set('If-None-Match', before);
    expect(stale.status).toBe(200);
  });

  it('never publishes tenant ids, internal ids or the origin allow-list', async () => {
    const res = await request(app).get(`/api/public/widgets/${aliceWidget.public_id}/config`);
    const keys = Object.keys(res.body);

    expect(keys).not.toContain('tenant_id');
    expect(keys).not.toContain('id');
    // Publishing this would hand an attacker the exact Origin header to forge.
    expect(keys).not.toContain('allowed_origins');
    expect(res.body.public_id).toBe(aliceWidget.public_id);
  });

  it('hides a deactivated widget from the public surface', async () => {
    const temp = await createWidget(alice.token, { title: 'Temporary' });
    await request(app).patch(`/api/widgets/${temp.id}`).set(auth(alice.token)).send({ is_active: false });

    expect((await request(app).get(`/api/public/widgets/${temp.public_id}/config`)).status).toBe(404);
    expect((await request(app).get(`/widget.js?id=${temp.public_id}`)).status).toBe(404);
    expect((await submit(temp.public_id, { email: 'a@b.co' }, { ip: freshIp() })).status).toBe(404);
  });
});
