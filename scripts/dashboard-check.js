#!/usr/bin/env node
/*
 * Drives the owner dashboard page the way a person would: load it, sign in,
 * wait for the tables to fill.
 *
 * The brief only asks for "endpoints + a simple table", so this is not a UI test
 * suite. It exists so the claim "the dashboard works" in EVIDENCE.md is a
 * command anyone can re-run, rather than a screenshot I could have faked.
 *
 * Usage: node scripts/dashboard-check.js [apiOrigin] [email] [password]
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const api = process.argv[2] || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
const email = process.argv[3] || 'owner@demo.test';
const password = process.argv[4] || 'demo-password-123';

const fail = (message) => {
  console.error('FAIL  ' + message);
  process.exit(1);
};
const ok = (message) => console.log('ok    ' + message);

const waitFor = async (predicate, label, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const page = await fetch(api + '/dashboard/');
if (!page.ok) fail(`the dashboard page did not respond (${page.status}). Is the API running?`);

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => console.error('  [page error]', err.message));

const dom = new JSDOM(await page.text(), {
  url: api + '/dashboard/',
  runScripts: 'dangerously',
  resources: 'usable',
  virtualConsole,
});
// jsdom ships no fetch; the page is same-origin with the API so a plain pass-through is right.
dom.window.fetch = (input, init) => fetch(input, init);

const doc = dom.window.document;
doc.getElementById('email').value = email;
doc.getElementById('password').value = password;
doc.getElementById('api').value = api;
doc.getElementById('login').click();

await waitFor(() => !doc.getElementById('app').classList.contains('hide'), 'sign-in to complete');
ok('signed in, dashboard revealed');

const tiles = await waitFor(
  () => (doc.querySelectorAll('#tiles .tile').length ? doc.querySelectorAll('#tiles .tile') : null),
  'the stat tiles',
);
for (const tile of tiles) {
  console.log(
    '      ' + tile.querySelector('.n').textContent.padStart(6) + '  ' + tile.querySelector('.k').textContent,
  );
}

const rows = await waitFor(() => {
  const found = doc.querySelectorAll('#submissions tbody tr');
  return found.length ? found : null;
}, 'the submissions table');

// One empty-state row is not the same as data; say so rather than passing.
if (rows.length === 1 && rows[0].children.length === 1) {
  fail('the submissions table is empty — run `npm run seed` and send a submission first');
}

ok(`submissions table rendered ${rows.length} rows`);
console.log('      ' + [...doc.querySelectorAll('#submissions thead th')].map((t) => t.textContent).join(' | '));
for (const row of [...rows].slice(0, 3)) {
  console.log('      ' + [...row.children].map((c) => c.textContent.slice(0, 28)).join(' | '));
}

const widgetRows = doc.querySelectorAll('#by-widget tbody tr');
const countryRows = doc.querySelectorAll('#by-country tbody tr');
ok(`per-widget table: ${widgetRows.length} rows | by-country table: ${countryRows.length} rows`);
console.log('      ' + doc.getElementById('pagination').textContent);

dom.window.close();
console.log('\nPASS  the owner dashboard page loads, authenticates and renders the tables');
process.exit(0);
