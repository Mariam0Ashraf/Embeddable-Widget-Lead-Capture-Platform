import { unauthorized } from '../../lib/errors.js';
import { verifyToken } from '../../lib/jwt.js';

/**
 * Owner-path guard. Populates `req.auth = { userId, tenantId, email }`; every
 * downstream repository call is scoped by that tenantId.
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return next(unauthorized('Missing Bearer token'));
  }

  try {
    req.auth = verifyToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}
