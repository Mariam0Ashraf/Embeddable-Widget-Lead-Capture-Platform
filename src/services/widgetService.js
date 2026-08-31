import { config } from '../lib/config.js';
import { notFound } from '../lib/errors.js';
import { publicId as generatePublicId } from '../lib/ids.js';
import {
  countWidgets,
  deleteWidget,
  findWidgetById,
  insertWidget,
  listWidgets,
  updateWidget,
} from '../repositories/widgetRepository.js';

// Changing any of these changes what the public config endpoint serves, so the
// version must advance and caches must roll over. `is_active` counts: it decides
// whether the widget renders at all.
const CONFIG_FIELDS = ['type', 'title', 'description', 'fields', 'button_text', 'display', 'is_active'];

export function buildEmbed(widget) {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    public_id: widget.public_id,
    script_url: `${base}/widget.js?id=${widget.public_id}`,
    config_url: `${base}/api/public/widgets/${widget.public_id}/config`,
    submit_url: `${base}/api/public/submissions`,
    snippet: `<script src="${base}/widget.js?id=${widget.public_id}" async></script>`,
  };
}

/** The owner-facing shape. Internal ids stay; this response is authenticated. */
export function presentWidget(widget) {
  return { ...widget, embed: buildEmbed(widget) };
}

export async function createWidget(tenantId, input) {
  const widget = await insertWidget({
    publicId: generatePublicId(),
    tenantId,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    fields: input.fields,
    buttonText: input.button_text,
    display: input.display,
    allowedOrigins: input.allowed_origins,
    isActive: input.is_active,
  });
  return presentWidget(widget);
}

export async function getWidgets(tenantId, { limit, offset }) {
  const [widgets, total] = await Promise.all([
    listWidgets(tenantId, { limit, offset }),
    countWidgets(tenantId),
  ]);
  return { data: widgets.map(presentWidget), pagination: { total, limit, offset } };
}

export async function getWidget(tenantId, id) {
  const widget = await findWidgetById(tenantId, id);
  // Another tenant's id is reported as 404, not 403: a 403 would confirm the
  // widget exists, which is itself a leak across the tenant boundary.
  if (!widget) throw notFound('Widget not found');
  return presentWidget(widget);
}

export async function patchWidget(tenantId, id, patch) {
  const existing = await findWidgetById(tenantId, id);
  if (!existing) throw notFound('Widget not found');

  const bumpVersion = CONFIG_FIELDS.some((field) => field in patch);
  const updated = await updateWidget(tenantId, id, patch, { bumpVersion });
  if (!updated) throw notFound('Widget not found');
  return presentWidget(updated);
}

export async function removeWidget(tenantId, id) {
  const deleted = await deleteWidget(tenantId, id);
  if (!deleted) throw notFound('Widget not found');
}

export async function getEmbed(tenantId, id) {
  const widget = await findWidgetById(tenantId, id);
  if (!widget) throw notFound('Widget not found');
  return buildEmbed(widget);
}
