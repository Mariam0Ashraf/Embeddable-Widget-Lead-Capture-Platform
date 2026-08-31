import { config } from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import { isPrivateIp } from '../../lib/net.js';
import { providerChain } from './providers.js';

/**
 * IP → location, trying each provider in order.
 *
 * This function is the "must not fail" boundary: it has no throw path. Whatever
 * happens upstream, the caller gets an object and the submission gets stored.
 * Losing a lead because a free geo API had a bad afternoon is not a trade any
 * customer would accept.
 *
 * @returns {{status:'enriched'|'unavailable'|'skipped', provider:string|null,
 *            geo:object|null, attempts:Array<{provider:string,ok:boolean,error?:string}>}}
 */
export async function enrichIp(ip, { chain = providerChain } = {}) {
  const attempts = [];

  if (!config.GEO_ENABLED) {
    return { status: 'skipped', provider: null, geo: null, reason: 'disabled', attempts };
  }
  if (isPrivateIp(ip)) {
    // Loopback in local dev. Asking a provider would waste the free quota and
    // return nothing useful.
    return { status: 'skipped', provider: null, geo: null, reason: 'private_ip', attempts };
  }

  for (const provider of chain) {
    try {
      const geo = await provider.lookup(ip, config.GEO_TIMEOUT_MS);
      attempts.push({ provider: provider.name, ok: true });
      logger.debug('geo enrichment succeeded', { provider: provider.name, attempts: attempts.length });
      return { status: 'enriched', provider: provider.name, geo, attempts };
    } catch (err) {
      attempts.push({ provider: provider.name, ok: false, error: err.message });
      logger.warn('geo provider failed, falling through', {
        provider: provider.name,
        error: err.message,
      });
    }
  }

  // Every provider is down. Degrade, never fail.
  logger.warn('geo enrichment unavailable, storing without location', { attempts });
  return { status: 'unavailable', provider: null, geo: null, attempts };
}
