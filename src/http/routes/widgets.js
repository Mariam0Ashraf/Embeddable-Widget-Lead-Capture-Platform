import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { isUuid, parseOrThrow } from '../../lib/validate.js';
import { notFound } from '../../lib/errors.js';
import {
  createWidgetSchema,
  listQuerySchema,
  updateWidgetSchema,
} from '../../services/widgetSchemas.js';
import {
  createWidget,
  getEmbed,
  getWidget,
  getWidgets,
  patchWidget,
  removeWidget,
} from '../../services/widgetService.js';

export const widgetsRouter = Router();

widgetsRouter.use('/api/widgets', authenticate);

// A non-UUID id would reach Postgres as invalid input and surface as a 500.
// It is simply "not found" — reject it here, before any query runs.
function widgetId(req) {
  if (!isUuid(req.params.id)) throw notFound('Widget not found');
  return req.params.id;
}

widgetsRouter.get('/api/widgets', async (req, res) => {
  const { limit, offset } = parseOrThrow(listQuerySchema, req.query);
  res.json(await getWidgets(req.auth.tenantId, { limit, offset }));
});

widgetsRouter.post('/api/widgets', async (req, res) => {
  const input = parseOrThrow(createWidgetSchema, req.body);
  res.status(201).json(await createWidget(req.auth.tenantId, input));
});

widgetsRouter.get('/api/widgets/:id', async (req, res) => {
  res.json(await getWidget(req.auth.tenantId, widgetId(req)));
});

widgetsRouter.patch('/api/widgets/:id', async (req, res) => {
  const patch = parseOrThrow(updateWidgetSchema, req.body);
  res.json(await patchWidget(req.auth.tenantId, widgetId(req), patch));
});

widgetsRouter.delete('/api/widgets/:id', async (req, res) => {
  await removeWidget(req.auth.tenantId, widgetId(req));
  res.status(204).end();
});

widgetsRouter.get('/api/widgets/:id/embed', async (req, res) => {
  res.json(await getEmbed(req.auth.tenantId, widgetId(req)));
});
