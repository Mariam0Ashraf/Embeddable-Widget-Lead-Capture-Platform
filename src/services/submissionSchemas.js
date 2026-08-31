import { z } from 'zod';
import { validationFailed } from '../lib/errors.js';

// The hidden input the widget renders and a human never sees. Its name is the
// contract between the bundle and this validator.
export const HONEYPOT_FIELD = '_hp';

export const MAX_FIELD_LENGTH = 1000;
export const MAX_DATA_KEYS = 30;

/**
 * The envelope — the part of the body whose shape is the same for every widget.
 * The per-widget `data` object is checked separately, against that widget's own
 * declared fields, because only the database knows what this widget asks for.
 */
export const submissionEnvelopeSchema = z
  .object({
    widget_id: z.string().min(1).max(64),
    data: z.record(z.string(), z.unknown()).default({}),
    [HONEYPOT_FIELD]: z.string().max(500).optional(),
    // Set by the bundle when it renders; used by the timing heuristic.
    rendered_at: z.number().int().positive().optional(),
  })
  .strict();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const TEL_RE = /^[+]?[\d\s().-]{6,25}$/;

/**
 * Validates `data` against the widget's own field definitions and returns a
 * cleaned object containing *only* declared fields.
 *
 * Two rules matter here. Unknown keys are rejected rather than dropped, so a
 * customer never wonders where a value went. And the returned object is rebuilt
 * from the field list rather than filtered in place, so nothing undeclared can
 * survive into storage even if a check above is later loosened.
 */
export function validateSubmissionData(fields, data) {
  const issues = [];
  const clean = {};

  if (Object.keys(data).length > MAX_DATA_KEYS) {
    throw validationFailed([
      { field: 'data', message: `At most ${MAX_DATA_KEYS} values may be submitted` },
    ]);
  }

  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(data)) {
    if (!declared.has(key)) {
      issues.push({ field: `data.${key}`, message: 'Unknown field for this widget' });
    }
  }

  for (const field of fields) {
    const raw = data[field.name];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (field.required) {
        issues.push({ field: `data.${field.name}`, message: `${field.label} is required` });
      }
      continue;
    }

    if (field.type === 'checkbox') {
      if (typeof raw !== 'boolean') {
        issues.push({ field: `data.${field.name}`, message: `${field.label} must be true or false` });
      } else {
        clean[field.name] = raw;
      }
      continue;
    }

    if (field.type === 'number') {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        issues.push({ field: `data.${field.name}`, message: `${field.label} must be a number` });
      } else {
        clean[field.name] = num;
      }
      continue;
    }

    if (typeof raw !== 'string') {
      issues.push({ field: `data.${field.name}`, message: `${field.label} must be text` });
      continue;
    }

    const value = raw.trim();
    const maxLength = Math.min(field.max_length ?? MAX_FIELD_LENGTH, MAX_FIELD_LENGTH);

    if (value.length > maxLength) {
      issues.push({
        field: `data.${field.name}`,
        message: `${field.label} must be at most ${maxLength} characters`,
      });
      continue;
    }
    if (field.type === 'email' && !EMAIL_RE.test(value)) {
      issues.push({ field: `data.${field.name}`, message: `${field.label} must be a valid email` });
      continue;
    }
    if (field.type === 'tel' && !TEL_RE.test(value)) {
      issues.push({ field: `data.${field.name}`, message: `${field.label} must be a valid phone number` });
      continue;
    }
    if (field.type === 'select' && !(field.options ?? []).includes(value)) {
      issues.push({ field: `data.${field.name}`, message: `${field.label} must be one of the offered options` });
      continue;
    }

    clean[field.name] = value;
  }

  if (issues.length > 0) throw validationFailed(issues);
  return clean;
}
