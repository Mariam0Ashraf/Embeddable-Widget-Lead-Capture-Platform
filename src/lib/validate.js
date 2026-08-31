import { validationFailed } from './errors.js';

/**
 * Parses `payload` with a Zod schema or throws a 400 carrying every issue at
 * once. Callers get validated data or nothing — never a half-checked object.
 */
export function parseOrThrow(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  throw validationFailed(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
      code: issue.code,
    })),
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed UUID. Guards Postgres from an invalid-input 500. */
export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
