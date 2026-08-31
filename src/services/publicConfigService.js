import { createHash } from 'node:crypto';
import { config } from '../lib/config.js';
import { notFound } from '../lib/errors.js';
import { findWidgetByPublicId } from '../repositories/widgetRepository.js';
import { HONEYPOT_FIELD } from './submissionSchemas.js';

/**
 * The config the public internet is allowed to see.
 *
 * Built by naming each key explicitly rather than deleting keys from the row.
 * A deny-list silently leaks whatever column gets added next; an allow-list
 * fails safe. Nothing here exposes the tenant id, the internal widget id, or
 * the origin allow-list — that last one would hand an attacker the exact
 * `Origin` header to forge.
 */
export function toPublicConfig(widget) {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    public_id: widget.public_id,
    type: widget.type,
    title: widget.title,
    description: widget.description,
    fields: widget.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: f.required,
      placeholder: f.placeholder,
      max_length: f.max_length,
      options: f.options,
    })),
    button_text: widget.button_text,
    display: widget.display,
    version: widget.config_version,
    submit_url: base + '/api/public/submissions',
    honeypot_field: HONEYPOT_FIELD,
  };
}

/** Weak ETag over the identity + version — the two things that change the body. */
export const configEtag = (widget) =>
  'W/"' + widget.public_id + '-' + widget.config_version + '"';

export async function getPublicConfig(publicId) {
  const widget = await findWidgetByPublicId(publicId);
  // An inactive widget is a 404 to the public: whether it exists is not the
  // internet's business.
  if (!widget || !widget.is_active) throw notFound('Widget not found');
  return { widget, config: toPublicConfig(widget), etag: configEtag(widget) };
}

export const sha8 = (content) => createHash('sha256').update(content).digest('hex').slice(0, 8);
