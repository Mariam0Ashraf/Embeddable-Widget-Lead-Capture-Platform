/**
 * Normalises an origin to `scheme://host[:port]` — lowercased, no path, no
 * trailing slash — so "https://Shop.com/" and "https://shop.com" compare equal.
 * Returns null for anything that isn't a usable http(s) origin.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '*') return '*';
  // A page opened straight off disk sends the opaque origin "null".
  if (trimmed === 'null') return 'null';

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * An empty allow-list means "embeddable anywhere", which is the useful default
 * for a widget product. A non-empty list is enforced exactly.
 */
export function originAllowed(origin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  if (allowedOrigins.includes('*')) return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowedOrigins.includes(normalized);
}
