import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { sha8 } from './publicConfigService.js';

const bundlePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'widget',
  'bundle.js',
);

// Read once at boot. The file is part of the image, so re-reading it per request
// would buy nothing but syscalls.
const bundleSource = readFileSync(bundlePath, 'utf8');

/**
 * The version token in the bundle URL is the build number *plus a hash of the
 * bundle's actual bytes*. That is what makes `immutable` honest: change one
 * character in bundle.js and the URL changes with it, so a browser can cache the
 * old URL forever and still never serve stale code.
 */
export const bundleVersion = 'v' + config.WIDGET_BUILD_VERSION + '-' + sha8(bundleSource);
export const bundleFilename = 'widget.' + bundleVersion + '.js';
export const getBundleSource = () => bundleSource;

const base = () => config.PUBLIC_BASE_URL.replace(/\/+$/, '');

export const bundleUrl = () => base() + '/static/' + bundleFilename;

/**
 * The per-widget loader. Tiny on purpose: it exists so the customer's one
 * `<script>` tag knows which widget to mount, and so the heavy bundle can be a
 * single cache entry shared by every widget on every site.
 *
 * The widget id is baked in server-side rather than parsed out of
 * `document.currentScript`, which is unreliable once a tag has been moved,
 * copied, or injected by a tag manager.
 */
export function buildLoaderSource(publicId) {
  return [
    '/* FlyRank widget loader — see ' + base() + ' */',
    '(function(){',
    '  var w = window.__FRW = window.__FRW || { queue: [], base: ' + JSON.stringify(base()) + ' };',
    '  w.base = ' + JSON.stringify(base()) + ';',
    '  w.queue.push(' + JSON.stringify(publicId) + ');',
    '  if (w.loading) return;',
    '  w.loading = true;',
    '  var s = document.createElement("script");',
    '  s.src = ' + JSON.stringify(bundleUrl()) + ';',
    '  s.async = true;',
    '  s.crossOrigin = "anonymous";',
    '  (document.head || document.documentElement).appendChild(s);',
    '})();',
    '',
  ].join('\n');
}
