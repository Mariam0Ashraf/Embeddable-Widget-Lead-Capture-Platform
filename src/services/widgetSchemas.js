import { z } from 'zod';
import { normalizeOrigin } from '../lib/origins.js';

export const WIDGET_TYPES = ['signup_form', 'contact_form', 'cta', 'popover'];
export const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'checkbox', 'select'];

// Field names become JSON keys on every submission and get echoed into HTML,
// so they are restricted to a boring identifier shape rather than sanitised later.
const fieldName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Field name must be lowercase letters, digits and underscores');

const fieldSchema = z
  .object({
    name: fieldName,
    label: z.string().trim().min(1).max(120),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    placeholder: z.string().max(120).optional(),
    max_length: z.number().int().min(1).max(5000).optional(),
    options: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'A select field needs at least one option' });
    }
  });

const fieldsSchema = z
  .array(fieldSchema)
  .max(25, 'A widget may define at most 25 fields')
  .superRefine((fields, ctx) => {
    const seen = new Set();
    for (const field of fields) {
      if (seen.has(field.name)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate field name "${field.name}"` });
      }
      seen.add(field.name);
    }
  });

const displaySchema = z
  .object({
    position: z.enum(['inline', 'bottom-right', 'bottom-left', 'center']).default('inline'),
    theme: z.enum(['light', 'dark']).default('light'),
    delay_ms: z.number().int().min(0).max(60_000).default(0),
    container_id: z.string().max(64).optional(),
    success_message: z.string().max(300).default('Thanks — we got it.'),
  })
  .strict();

// An empty allow-list means "any origin", which is the sane default for an
// embeddable widget. Values are normalised on the way in so comparison later
// is a plain string match rather than URL parsing on the hot path.
const allowedOriginsSchema = z
  .array(z.string().max(255))
  .max(50)
  .transform((origins, ctx) => {
    const out = [];
    for (const raw of origins) {
      const normalized = normalizeOrigin(raw);
      if (!normalized) {
        ctx.addIssue({ code: 'custom', message: `"${raw}" is not a valid origin` });
        continue;
      }
      if (!out.includes(normalized)) out.push(normalized);
    }
    return out;
  });

export const createWidgetSchema = z
  .object({
    type: z.enum(WIDGET_TYPES),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    fields: fieldsSchema.default([]),
    button_text: z.string().trim().min(1).max(60).default('Submit'),
    // prefault, not default: `.default({})` would store the literal empty object
    // and skip the inner defaults, leaving the public config without a position
    // or success message for the bundle to render.
    display: displaySchema.prefault({}),
    allowed_origins: allowedOriginsSchema.default([]),
    is_active: z.boolean().default(true),
  })
  .strict();

// Same rules, every key optional — but at least one must be present, so an
// empty PATCH is a 400 rather than a silent no-op that looks like success.
export const updateWidgetSchema = z
  .object({
    type: z.enum(WIDGET_TYPES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    fields: fieldsSchema.optional(),
    button_text: z.string().trim().min(1).max(60).optional(),
    display: displaySchema.optional(),
    allowed_origins: allowedOriginsSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
