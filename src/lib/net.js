// IPv4-mapped IPv6 ("::ffff:203.0.113.9") is what Node hands you on a
// dual-stack socket; geo providers want the plain v4 form.
export function normalizeIp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

/** Loopback and RFC1918 addresses have no meaningful geolocation — don't ask. */
export function isPrivateIp(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === 'localhost') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return PRIVATE_V4.some((re) => re.test(ip));
}

/** The client IP, honouring exactly the one proxy hop we configured. */
export function clientIp(req) {
  return normalizeIp(req.ip) ?? null;
}
