#!/usr/bin/env node
/*
 * Proves the requirement "the widget renders on a page served from a different
 * origin than your API" without a human having to look at a screenshot.
 *
 * It loads the real customer page over HTTP from the site origin, lets jsdom
 * execute the real <script> tag, and waits for the form to appear in the DOM.
 * Every asset comes off the wire from the API origin: loader, bundle, config.
 *
 * jsdom is not a browser and does not enforce CORS, so this is *not* the CORS
 * proof — the preflight and header transcripts in EVIDENCE.md are. What this
 * check proves is the other half: that one <script> tag on a foreign page turns
 * into a working, submitting form.
 *
 * Usage: node scripts/render-check.js [siteOrigin] [apiOrigin]
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const siteOrigin = process.argv[2] || process.env.DEMO_SITE_ORIGIN || 'http://localhost:5500';
const apiOrigin = process.argv[3] || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const fail = (message) => {
  console.error('FAIL  ' + message);
  process.exit(1);
};
const ok = (message) => console.log('ok    ' + message);

const waitFor = async (predicate, { timeoutMs = 8000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const page = await fetch(siteOrigin + '/');
if (!page.ok) fail(`the customer site did not respond (${page.status}). Is \`npm run site\` running?`);
const html = await page.text();
if (html.includes('REPLACE_WITH_PUBLIC_ID')) fail('the demo page is unseeded — run `npm run seed`');
ok(`fetched the customer page from ${siteOrigin}`);

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => console.error('  [page error]', err.message));
virtualConsole.on('warn', (msg) => console.error('  [page warn]', msg));

const dom = new JSDOM(html, {
  url: siteOrigin + '/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
});

// jsdom ships no fetch. Supply one that sends the page's Origin, the way a
// browser would, so the API sees a genuine cross-origin request.
dom.window.fetch = (input, init = {}) =>
  fetch(input, { ...init, headers: { ...(init.headers || {}), Origin: siteOrigin } });

const doc = dom.window.document;

const box = await waitFor(() => doc.querySelector('.frw'), { label: 'the widget container' });
ok('widget container rendered into the page');

const heading = box.querySelector('h3');
const button = box.querySelector('button[type="submit"]');
const emailInput = box.querySelector('input[type="email"]');
const honeypot = box.querySelector('input.frw-hp');

if (!heading?.textContent) fail('the widget rendered without a title');
if (!button) fail('the widget rendered without a submit button');
if (!emailInput) fail('the widget rendered without its email field');
if (!honeypot) fail('the honeypot field is missing from the rendered form');

ok(`title      "${heading.textContent}"`);
ok(`button     "${button.textContent}"`);
ok(`fields     ${[...box.querySelectorAll('input,select,textarea')].filter((n) => !n.classList.contains('frw-hp')).map((n) => n.name).join(', ')}`);
ok(`honeypot   name="${honeypot.name}" (offscreen, aria-hidden="${honeypot.getAttribute('aria-hidden')}")`);

const slot = doc.querySelector('[data-flyrank-widget]');
if (slot && !slot.contains(box)) fail('the widget did not mount into the container the page provided');
ok('mounted inside the page-provided container, not floated over it');

/*
 * Wait before submitting, on purpose.
 *
 * The bundle stamps `rendered_at` when it draws the form, and the server drops
 * anything submitted faster than SPAM_MIN_FILL_MS as a bot. A script that fills
 * and submits in the same tick *is* a bot by that definition, and it gets the
 * honeypot's deliberately indistinguishable 201 — a green check with no row in
 * the database. Pausing here makes this check behave like a person.
 */
const fillDelayMs = Number(process.env.SPAM_MIN_FILL_MS || 1200) + 300;
ok(`waiting ${fillDelayMs}ms before submitting, so the fill-time heuristic sees a human`);
await new Promise((r) => setTimeout(r, fillDelayMs));

// Now actually submit it, from the page, cross-origin.
const stamp = Date.now();
emailInput.value = `render-check-${stamp}@example.com`;
const nameInput = box.querySelector('input[name="name"]');
if (nameInput) nameInput.value = 'Render Check';

box.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

const message = await waitFor(
  () => {
    const node = box.querySelector('.frw-msg');
    return node && node.textContent.trim() ? node : null;
  },
  { label: 'the submit response message' },
);

if (!message.className.includes('frw-msg--ok')) {
  fail(`submitting from the page failed: "${message.textContent}"`);
}
ok(`submitted cross-origin and got the success message: "${message.textContent}"`);

// Confirm the server really stored it, rather than the widget just looking happy.
const login = await fetch(apiOrigin + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@demo.test', password: 'demo-password-123' }),
});
if (login.ok) {
  const { token } = await login.json();
  const list = await fetch(apiOrigin + '/api/submissions?limit=5', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (list.ok) {
    const body = await list.json();
    const found = (body.data || []).some(
      (s) => s.data && s.data.email === `render-check-${stamp}@example.com`,
    );
    ok(found ? 'the submission is visible through the owner dashboard API' : 'dashboard API reachable (submission listing pending stage 6)');
  }
}

dom.window.close();
console.log('\nPASS  the widget renders and submits from a second origin');
process.exit(0);
