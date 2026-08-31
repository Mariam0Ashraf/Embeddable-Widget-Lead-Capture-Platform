import { Router } from 'express';
import { config } from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import { notFound } from '../../lib/errors.js';
import { openCors } from '../middleware/publicCors.js';
import { getPublicConfig } from '../../services/publicConfigService.js';
import {
  buildLoaderSource,
  bundleFilename,
  bundleVersion,
  getBundleSource,
} from '../../services/widgetAssetService.js';

export const widgetDeliveryRouter = Router();

/*
 * Three public, cacheable responses with three different cache lifetimes,
 * because they change at three different rates:
 *
 *   /widget.js?id=…              short   — the customer's <script> tag; it must
 *                                          pick up a new bundle URL within minutes
 *   /static/widget.<version>.js  forever — the URL contains a hash of the content
 *   /api/public/widgets/:id/config  short + ETag — changes when the owner edits
 */

const PUBLIC_CACHE = (seconds) => 'public, max-age=' + seconds;

// --- 1 · the loader --------------------------------------------------------
widgetDeliveryRouter.get('/widget.js', openCors, async (req, res, next) => {
  const publicId = typeof req.query.id === 'string' ? req.query.id : '';

  if (!/^[a-z0-9]{4,64}$/.test(publicId)) {
    return next(notFound('Widget not found'));
  }

  try {
    // Confirm the widget exists and is live before handing out a loader, so a
    // deleted widget stops loading rather than 404-ing from inside the bundle.
    await getPublicConfig(publicId);
  } catch (err) {
    return next(err);
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', PUBLIC_CACHE(config.LOADER_CACHE_MAX_AGE));
  res.setHeader('X-Widget-Bundle', bundleVersion);
  return res.send(buildLoaderSource(publicId));
});

// --- 2 · the versioned bundle ---------------------------------------------
widgetDeliveryRouter.get('/static/widget.:version.js', openCors, (req, res) => {
  const requested = req.params.version;
  const current = requested === bundleVersion;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  if (current) {
    // Safe to cache for a year: a different bundle would have a different URL.
    res.setHeader('Cache-Control', 'public, max-age=' + config.BUNDLE_CACHE_MAX_AGE + ', immutable');
  } else {
    // A loader cached before the last release can still ask for the previous
    // URL for a few minutes. Serving current code with no-cache keeps that
    // customer's page working without ever caching content under a URL that
    // does not describe it.
    logger.warn('bundle requested at a stale version', {
      requested,
      current: bundleVersion,
      request_id: req.id,
    });
    res.setHeader('Cache-Control', 'no-cache');
  }

  res.setHeader('X-Widget-Bundle', bundleVersion);
  res.send(getBundleSource());
});

// --- 3 · the public config -------------------------------------------------
widgetDeliveryRouter.get(
  '/api/public/widgets/:publicId/config',
  openCors,
  async (req, res, next) => {
    let result;
    try {
      result = await getPublicConfig(req.params.publicId);
    } catch (err) {
      return next(err);
    }

    res.setHeader('Cache-Control', PUBLIC_CACHE(config.CONFIG_CACHE_MAX_AGE));
    res.setHeader('ETag', result.etag);

    // A revalidating browser gets 304 and no body at all — the cheapest possible
    // response for the most frequently requested endpoint in the system.
    if (req.get('if-none-match') === result.etag) {
      return res.status(304).end();
    }

    return res.json(result.config);
  },
);

export { bundleFilename };
