import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { unauthorized } from './errors.js';

export function signToken({ userId, tenantId, email }) {
  return jwt.sign({ tenant_id: tenantId, email }, config.JWT_SECRET, {
    subject: userId,
    expiresIn: config.JWT_EXPIRES_IN,
  });
}

/** Verifies a token and returns the caller's identity, or throws a clean 401. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    return { userId: payload.sub, tenantId: payload.tenant_id, email: payload.email };
  } catch (err) {
    // The reason is deliberately vague to the client, precise in the message.
    if (err.name === 'TokenExpiredError') throw unauthorized('Token has expired');
    throw unauthorized('Invalid authentication token');
  }
}
