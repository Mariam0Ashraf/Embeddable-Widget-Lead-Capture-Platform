import bcrypt from 'bcryptjs';
import { withTransaction } from '../lib/db.js';
import { config } from '../lib/config.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import { createTenantWithUser, findUserByEmail } from '../repositories/userRepository.js';

export async function register({ email, password, tenantName }) {
  const existing = await findUserByEmail(email);
  if (existing) throw conflict('An account with that email already exists');

  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);

  let created;
  try {
    created = await withTransaction((client) =>
      createTenantWithUser(client, {
        tenantName: tenantName || email.split('@')[0],
        email,
        passwordHash,
      }),
    );
  } catch (err) {
    // Two simultaneous registrations race past the check above; the unique
    // index is the real guard, so translate its violation instead of 500-ing.
    if (err.code === '23505') throw conflict('An account with that email already exists');
    throw err;
  }

  return {
    token: signToken({
      userId: created.user.id,
      tenantId: created.tenant.id,
      email: created.user.email,
    }),
    user: { id: created.user.id, email: created.user.email, tenant_id: created.tenant.id },
    tenant: { id: created.tenant.id, name: created.tenant.name },
  };
}

export async function login({ email, password }) {
  const user = await findUserByEmail(email);

  // Hash even when the user is missing, so response time doesn't reveal which
  // emails are registered, and answer identically either way.
  const hash = user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) throw unauthorized('Invalid email or password');

  return {
    token: signToken({ userId: user.id, tenantId: user.tenant_id, email: user.email }),
    user: { id: user.id, email: user.email, tenant_id: user.tenant_id },
  };
}
