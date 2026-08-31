import { config } from '../../lib/config.js';

/**
 * Each provider has a mode:
 *   live    — call the real free API
 *   mock_ok — answer instantly with canned data (deterministic fallback proof)
 *   down    — throw immediately, as if the upstream were unreachable
 *
 * The brief asks for the fallback to be *provable*, and a proof that depends on
 * a third party being up is not a proof. Modes are env-driven, so the same code
 * path runs in the demo and in the test.
 */

class ProviderDown extends Error {
  constructor(provider) {
    super(`${provider} is unavailable`);
    this.name = 'ProviderDown';
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'flyrank-widget-platform/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const shape = ({ country, countryCode, region, city, lat, lon }) => ({
  country: country ?? null,
  country_code: countryCode ?? null,
  region: region ?? null,
  city: city ?? null,
  lat: typeof lat === 'number' ? lat : null,
  lon: typeof lon === 'number' ? lon : null,
});

// --- Provider A: ip-api.com (no key, 45 req/min) ---------------------------
export const providerA = {
  name: 'ip-api.com',
  mode: () => config.GEO_PROVIDER_A_MODE,
  async lookup(ip, timeoutMs) {
    const mode = config.GEO_PROVIDER_A_MODE;
    if (mode === 'down') throw new ProviderDown('ip-api.com');
    if (mode === 'mock_ok') {
      return shape({
        country: 'Germany',
        countryCode: 'DE',
        region: 'Berlin',
        city: 'Berlin',
        lat: 52.52,
        lon: 13.405,
      });
    }

    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon`;
    const body = await fetchJson(url, timeoutMs);
    // ip-api reports failure in the body with HTTP 200, so a 200 is not success.
    if (body.status !== 'success') throw new Error(body.message || 'lookup failed');
    return shape({
      country: body.country,
      countryCode: body.countryCode,
      region: body.regionName,
      city: body.city,
      lat: body.lat,
      lon: body.lon,
    });
  },
};

// --- Provider B: ipapi.co (~1,000 lookups/day) -----------------------------
export const providerB = {
  name: 'ipapi.co',
  mode: () => config.GEO_PROVIDER_B_MODE,
  async lookup(ip, timeoutMs) {
    const mode = config.GEO_PROVIDER_B_MODE;
    if (mode === 'down') throw new ProviderDown('ipapi.co');
    if (mode === 'mock_ok') {
      return shape({
        country: 'Portugal',
        countryCode: 'PT',
        region: 'Lisbon',
        city: 'Lisbon',
        lat: 38.7223,
        lon: -9.1393,
      });
    }

    const body = await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, timeoutMs);
    if (body.error) throw new Error(body.reason || 'lookup failed');
    return shape({
      country: body.country_name,
      countryCode: body.country_code,
      region: body.region,
      city: body.city,
      lat: body.latitude,
      lon: body.longitude,
    });
  },
};

export const providerChain = [providerA, providerB];
