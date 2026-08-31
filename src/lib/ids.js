import { randomBytes } from 'node:crypto';

// Unambiguous alphabet: no 0/O, no 1/l/I. Public ids get read aloud and pasted
// by hand, so the characters people confuse are simply not in the set.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

export function publicId(length = 12) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const requestId = () => randomBytes(8).toString('hex');
