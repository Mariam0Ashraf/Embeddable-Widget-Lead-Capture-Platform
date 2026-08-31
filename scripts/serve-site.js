#!/usr/bin/env node
/*
 * Serves the pretend customer website on its own port.
 *
 * This is a separate origin, not a separate machine — which is exactly what the
 * capstone needs. http://localhost:5500 and http://localhost:3000 differ by port,
 * and a different port is a different origin as far as the browser is concerned,
 * so every request the widget makes from here is genuinely cross-origin.
 *
 * No dependencies on purpose: `npx serve` or `python -m http.server` would do the
 * same job, and this keeps the whole demo inside one `docker compose up`.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site');
const port = Number(process.env.SITE_PORT || 5500);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const NOT_SEEDED = `<!doctype html>
<meta charset="utf-8"><title>Demo site not seeded yet</title>
<body style="font:16px system-ui;max-width:640px;margin:60px auto;padding:0 20px">
<h1>Demo site not generated yet</h1>
<p>The customer test page is built from
<code>public/site/index.template.html</code> with a real widget id baked in.</p>
<p>Run the seed step, then reload:</p>
<pre style="background:#14181d;color:#e6edf3;padding:14px;border-radius:8px">docker compose exec api npm run seed</pre>
<p>or, running locally: <code>npm run seed</code></p>
</body>`;

const server = createServer(async (req, res) => {
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');

  // Resolve, then confirm the result is still inside the site directory — the
  // one thing a hand-rolled static server must never get wrong.
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      // The demo page changes every time you re-seed; never let it be cached.
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  } catch {
    if (relative === 'index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(NOT_SEEDED);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`customer test site on http://localhost:${port} (a different origin to the API)`);
});
