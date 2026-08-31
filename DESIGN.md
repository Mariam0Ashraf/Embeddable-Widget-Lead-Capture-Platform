# Design — Embeddable Widget & Lead-Capture Platform

One page. Written before the code (Phase 1 gate). Revised only when the code proved a decision wrong;
those revisions are noted in `BUILDLOG.md`.

## Problem

A customer defines a widget in an authenticated admin API, pastes one `<script>` tag on a website we do
not control, and every visitor submission comes back to us over the open internet. The submission path
must survive untrusted input, hostile volume, and dead upstream dependencies without ever losing a
legitimate lead.

## Explicit non-goal

**No visual widget builder and no hosted customer frontend.** The dashboard is a JSON API plus one
throwaway HTML table; the widget UI is an unstyled form. Every hour spent on CSS is an hour not spent on
the submission path, which is the part that actually has to hold.

Secondary non-goals: no real CDN/domain/hosting (localhost is the deployment target), no multi-user
teams inside a tenant (one user = one tenant), no email deliverability (Mailpit or console).

## Data model

| Table | Columns that matter | Notes |
|---|---|---|
| `tenants` | `id`, `name`, `created_at` | the isolation boundary |
| `users` | `id`, `tenant_id`, `email` (unique), `password_hash` | login → JWT carrying `tenant_id` |
| `widgets` | `id` (uuid, internal), `public_id` (12-char opaque, in the embed URL), `tenant_id`, `type`, `title`, `description`, `fields` (jsonb), `button_text`, `display` (jsonb), `allowed_origins` (text[]), `config_version` (int), `is_active`, timestamps | `public_id` is separate from `id` so the public surface is not enumerable and can be rotated |
| `submissions` | `id`, `widget_id`, `tenant_id` (denormalised), `data` (jsonb), `ip`, `user_agent`, `referer`, `geo` (jsonb), `geo_provider`, `geo_status`, `idempotency_key`, `created_at` | `tenant_id` copied onto the row so every dashboard query filters by tenant without a join |
| `side_effect_jobs` | `id`, `submission_id`, `type`, `payload` (jsonb), `status`, `attempts`, `next_attempt_at`, `last_error`, timestamps | transactional outbox for the confirmation email / webhook |
| `schema_migrations` | `version`, `applied_at` | plain SQL migrations, applied in order |

Indexes: `widgets(public_id)` unique · `widgets(tenant_id)` · `submissions(tenant_id, created_at desc)`
· `submissions(widget_id, created_at desc)` · `submissions(widget_id, idempotency_key)` unique (partial,
where the key is not null) · `side_effect_jobs(status, next_attempt_at)`.

**Tenancy is enforced in the repository layer**: every widget/submission query takes `tenant_id` as a
mandatory argument and puts it in the `WHERE` clause. There is no "fetch by id then check owner" path,
because that is the one people forget to write.

## The embed flow

```
owner: POST /api/widgets                  -> { public_id, embed_snippet }
site:  <script src=".../widget.js?id=PUB"></script>
       GET  /widget.js?id=PUB             -> tiny loader, Cache-Control max-age=300
       GET  /static/widget.<build>.js     -> versioned bundle, max-age=1y, immutable
       GET  /api/public/widgets/PUB/config-> JSON + ETag, max-age=60, CORS *
       render form into a container div
visitor: POST /api/public/submissions     -> CORS (per-widget origins), preflight OPTIONS
```

New bundle content = new `<build>` in the URL, so the bundle caches forever and never goes stale.
Config changes bump `config_version` and the short max-age carries the change within a minute.

## API contracts — three request paths, kept separate

**1 · Owner (authenticated, `Authorization: Bearer <jwt>`)**

```
POST   /api/auth/register        -> 201 { token }
POST   /api/auth/login           -> 200 { token }
GET    /api/widgets              -> 200 [widget]          (tenant-scoped)
POST   /api/widgets              -> 201 widget + snippet
GET    /api/widgets/:id          -> 200 | 404 (404, not 403, for another tenant's id)
PATCH  /api/widgets/:id          -> 200 | 404
DELETE /api/widgets/:id          -> 204 | 404
GET    /api/widgets/:id/embed    -> 200 { snippet }
GET    /api/submissions          -> 200 paginated, filters: widget_id, from, to
GET    /api/stats/overview       -> 200 { total, by_day[], by_widget[], by_country[] }
```

**2 · Customer site (public, cached, CORS `*`, no auth)**

```
GET /widget.js?id=PUB            -> JS loader
GET /static/widget.<build>.js    -> JS bundle
GET /api/public/widgets/PUB/config -> { public_id, type, title, fields[], button_text, display, version }
```
The config response never contains tenant ids, internal widget ids, or origin lists.

**3 · Visitor (public, CORS per widget, protected)**

```
OPTIONS /api/public/submissions  -> 204 preflight
POST    /api/public/submissions  -> 201 { id } | 400 | 404 | 413 | 429
```

Body: `{ widget_id: PUB, data: {…}, hp_field?: "" }`, optional `Idempotency-Key` header.

## Layers

```
src/http/         routes, middleware, error handler   — knows HTTP, knows no SQL
src/services/     widgets, submissions, geo, stats    — knows the rules, knows no req/res
src/repositories/ parameterised SQL                   — knows the tables, takes tenant_id
src/lib/          db pool, config, logger, errors, ids
```
Services throw typed `AppError`s; one HTTP error handler maps them to status + JSON body. Nothing below
`src/http` ever touches `req` or `res`.

## The submission pipeline

```
POST /api/public/submissions
 1 body size cap (express.json limit)        -> 413
 2 zod schema + per-widget field validation  -> 400 { error, details[] }
 3 widget lookup by public_id, must be active-> 404
 4 origin check + rate limit (ip, widget)    -> 429  (Retry-After)
 5 honeypot / timing heuristic               -> 201 fake success, row silently dropped
 6 geo enrichment: provider A -> B -> none   -> never throws, 1.5s timeout each
 7 INSERT submission + INSERT outbox job     -> one transaction
 8 respond 201
 9 worker (separate loop) drains the outbox  -> retries w/ backoff, alert after max attempts
```

Steps 6 and 9 are the two "must not fail" boundaries: enrichment returns `null` geo instead of throwing,
and the side effect lives *after* the response in a background worker, so a dead SMTP host cannot cost us
a lead. Idempotency is at step 7 — a retried POST with the same `Idempotency-Key` returns the original
row instead of inserting a second one.

## Failure & abuse posture

- Rate limit: sliding window in memory, per IP and per widget, configurable; returns `429` + `Retry-After`
  and keeps serving everyone else.
- Spam: hidden honeypot field, plus a minimum time-to-submit heuristic. A bot gets `201` and no row —
  telling it why would only help it.
- Geo providers are behind one interface with a `live | mock_ok | down` mode per provider, so the
  fallback proof in `EVIDENCE.md` is deterministic instead of depending on a third party being up.
- Secrets: `.env` only, git-ignored, never logged; the logger redacts `password`, `token`, `authorization`.
