# flyrank-capstone-widget-platform

An embeddable widget and lead-capture platform. A customer defines a widget through an authenticated
API, pastes **one line of `<script>`** into any website, and every visitor submission comes back here to
be validated, rate-limited, spam-filtered, geo-enriched, stored, and reported on.

The interesting part is not the CRUD. It is that the submission endpoint is open to the public internet:
the input cannot be trusted, the traffic cannot be controlled, the origin cannot be predicted, and the
dependencies will go down. This README says what the system does about each of those.

FlyRank Internship · Backend Track · Capstone.

---

## Quick start

Two commands. Nothing to configure, no credit card, no cloud account.

```bash
docker compose up --build          # API :3000 · Postgres :5433 · Mailpit :8025 · demo site :5500
docker compose exec api npm run seed
```

Then open:

| URL | What it is |
|---|---|
| <http://localhost:5500> | The **customer website** — a different origin, with the widget embedded |
| <http://localhost:3000/dashboard/> | The **owner dashboard** (credentials are pre-filled) |
| <http://localhost:3000/health> | Liveness + database check |
| <http://localhost:8025> | Mailpit, if you switch `SIDE_EFFECT_TRANSPORT` to `smtp` |

The seed prints the owner login (`owner@demo.test` / `demo-password-123`), creates two widgets, and
writes the customer test page with a real widget id baked in.

> **Postgres is published on 5433, not 5432.** A Postgres already running on the host wins over Docker's
> port proxy, and the failure looks like a password error rather than a conflict. 5433 sidesteps it.

<details>
<summary>Running without Docker</summary>

```bash
cp .env.example .env          # then set JWT_SECRET to something long
docker compose up -d db       # or point DATABASE_URL at any Postgres 13+
npm install
npm run migrate
npm run seed
npm start                     # API on :3000
npm run site                  # customer site on :5500, in a second terminal
```
</details>

---

## Architecture

Three request paths, kept apart on purpose. The owner path is authenticated and tenant-scoped, the
delivery path is public and cached, the visitor path is public and defended. Nothing crosses over.

```
┌─ OWNER ─────────────────── authenticated, tenant-scoped ────────────────────┐
│  POST /api/auth/login ──► JWT (carries tenant_id)                           │
│  CRUD /api/widgets    ──► widget row ──► embed snippet                      │
│  GET  /api/submissions, /api/stats/overview ◄── submissions + aggregates    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ CUSTOMER SITE ─────────── any origin, public, cached ──────────────────────┐
│  <script src="…/widget.js?id=abc123"></script>                              │
│      │                                                                      │
│      ├─► GET /widget.js?id=…            loader     Cache-Control max-age=300│
│      ├─► GET /static/widget.v1-<hash>.js bundle    max-age=1y, immutable    │
│      └─► GET /api/public/widgets/:id/config        max-age=60 + ETag → 304  │
│              └─► renders the form into the page                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ VISITOR ───────────────── public, CORS, protected ─────────────────────────┐
│  OPTIONS /api/public/submissions ──────────────► 204 preflight              │
│  POST    /api/public/submissions                                            │
│     │                                                                       │
│     ├─ 1  body size cap ...................................► 413            │
│     ├─ 2  per-IP rate limit ...............................► 429 + Retry-After
│     ├─ 3  envelope schema (zod) ...........................► 400            │
│     ├─ 4  per-widget rate limit ...........................► 429            │
│     ├─ 5  widget lookup, must be active ...................► 404            │
│     ├─ 6  origin allow-list (server-side, not just CORS) ..► 403            │
│     ├─ 7  honeypot + fill-time heuristic ..................► 201, nothing stored
│     ├─ 8  per-widget field validation .....................► 400 + details[]
│     ├─ 9  geo enrichment   A ─fails─► B ─fails─► store anyway (never throws)│
│     ├─ 10 INSERT submission + INSERT outbox job  ── one transaction ──►     │
│     └─ 11 respond 201                                                       │
│                                                                             │
│  background worker ──► drains outbox ──► email/webhook                      │
│                        retry 2s → 4s → 8s ──► dead-letter + alert           │
└─────────────────────────────────────────────────────────────────────────────┘
```

Steps 9 and 11 are the two boundaries that must not fail. Enrichment has no throw path — it returns
`unavailable` and the lead is stored without geo. The side effect happens *after* the response, in a
worker draining a transactional outbox, so a dead SMTP host cannot cost a lead.

### Layers

```
src/http/          routes, middleware, one error handler   — knows HTTP, knows no SQL
src/services/      widgets, submissions, geo, spam, stats  — knows the rules, never sees req/res
src/repositories/  parameterised SQL, tenant_id required   — knows the tables
src/workers/       the outbox drainer
src/lib/           config, db pool, logger, errors, jwt, rate limiter, ids
```

Services throw typed `AppError`s; [one error handler](src/http/middleware/errorHandler.js) turns them
into a status and a JSON body. A 5xx from this API means a bug, not bad input.

### Data model

| Table | Purpose | Notable indexes |
|---|---|---|
| `tenants` | the isolation boundary | |
| `users` | login → JWT carrying `tenant_id` | unique on `lower(email)` |
| `widgets` | config, fields, `allowed_origins`, `config_version` | unique `public_id`, `(tenant_id, created_at desc)` |
| `submissions` | the leads, with `geo`, `ip`, `origin` | `(tenant_id, created_at desc)`, `(widget_id, created_at desc)`, unique `(widget_id, idempotency_key)` partial |
| `side_effect_jobs` | transactional outbox | `(status, next_attempt_at)` |

Two decisions worth naming:

- **`public_id` is separate from the widget's UUID.** The embed URL exposes a 12-character opaque id, so
  the public surface is not enumerable and can be rotated without touching foreign keys.
- **`tenant_id` is denormalised onto `submissions`.** Every dashboard query filters by tenant without a
  join, which is what makes the isolation guarantee cheap enough that no query is tempted to skip it.

---

## API

### Owner — `Authorization: Bearer <jwt>`

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/register` | `{ email, password, tenant_name? }` → `201 { token, user, tenant }` |
| `POST` | `/api/auth/login` | → `200 { token }` |
| `GET` | `/api/auth/me` | current identity |
| `GET` | `/api/widgets` | `?limit&offset` — tenant-scoped |
| `POST` | `/api/widgets` | → `201` widget + `embed` block |
| `GET` | `/api/widgets/:id` | `404` for another tenant's id |
| `PATCH` | `/api/widgets/:id` | bumps `config_version` when the public config changes |
| `DELETE` | `/api/widgets/:id` | `204` |
| `GET` | `/api/widgets/:id/embed` | the snippet, script URL, config URL, submit URL |
| `GET` | `/api/submissions` | `?widget_id&from&to&limit&offset` |
| `GET` | `/api/submissions/:id` | |
| `GET` | `/api/stats/overview` | `?days&widget_id&countries` |

<details>
<summary>Create a widget</summary>

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"demo-password-123"}' | jq -r .token)

curl -s -X POST localhost:3000/api/widgets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "type": "signup_form",
    "title": "Join the roast list",
    "fields": [
      { "name": "email", "label": "Email", "type": "email", "required": true },
      { "name": "roast", "label": "Roast", "type": "select", "options": ["light","dark"] }
    ],
    "button_text": "Subscribe",
    "allowed_origins": ["http://localhost:5500"]
  }'
```

Field types: `text · email · tel · number · textarea · checkbox · select`.
Widget types: `signup_form · contact_form · cta · popover`.
An empty `allowed_origins` means the widget may be embedded anywhere.
</details>

<details>
<summary>Stats response shape</summary>

```jsonc
{
  "totals":   { "submissions": 11, "widgets": 2, "enriched": 8, "enrichment_rate": 72.7 },
  "by_day":   [{ "day": "2026-08-31", "count": 11 }],   // zero-filled: a quiet day is 0, not a gap
  "by_widget":  [{ "title": "Join the roast list", "count": 8, "last_submission_at": "…" }],
  "by_country": [{ "country_code": "DE", "country": "Germany", "count": 5 }],
  "by_enrichment": [{ "geo_status": "enriched", "provider": "ip-api.com", "count": 5 }],
  "side_effects":  [{ "status": "done", "count": 11 }]
}
```
</details>

### Public — no auth

| Method | Path | Cache | Notes |
|---|---|---|---|
| `GET` | `/widget.js?id=<public_id>` | `max-age=300` | the loader; `404` if the widget is gone or inactive |
| `GET` | `/static/widget.<version>.js` | `max-age=1y, immutable` | version = build number + hash of the file |
| `GET` | `/api/public/widgets/:publicId/config` | `max-age=60` + `ETag` | no tenant id, no internal id, no origin list |
| `OPTIONS` | `/api/public/submissions` | — | `204` preflight |
| `POST` | `/api/public/submissions` | — | see below |

```jsonc
// POST /api/public/submissions        headers: Origin, Idempotency-Key (optional)
{
  "widget_id": "xkh8gdncg4ia",
  "data": { "email": "visitor@example.com", "roast": "dark" },
  "rendered_at": 1788169094045,   // stamped by the bundle; drives the fill-time heuristic
  "_hp": ""                       // honeypot; a human leaves it empty
}
```

| Status | When |
|---|---|
| `201` | stored — **or** silently dropped as spam (deliberately indistinguishable) |
| `200` | idempotent replay; body carries `"idempotent_replay": true` |
| `400` | bad JSON, unknown envelope key, or field validation, with `details[]` per field |
| `403` | the `Origin` is not on this widget's allow-list |
| `404` | unknown or deactivated widget |
| `413` | body over `SUBMISSION_BODY_LIMIT` |
| `429` | per-IP or per-widget limit, with `Retry-After` |

---

## How the hard parts work

**CORS.** The middleware is mounted **before** the body parser. Mounted after, a `413` or a
malformed-JSON `400` carries no `Access-Control-Allow-Origin`, the browser refuses to expose the
response, and a correct 413 reaches the customer's developer as "blocked by CORS". Preflight is answered
for any origin — an `OPTIONS` request has no body, so it cannot know which widget is being addressed —
and the per-widget allow-list is enforced on the `POST`, **in the service layer**, because `curl` ignores
CORS entirely and a header is not access control.

**Rate limiting.** Sliding window per IP and per widget. The per-IP check runs before the widget lookup,
so a flood costs one map lookup rather than a database round trip. `trust proxy` is set to `1`, not
`true`: trusting the whole `X-Forwarded-For` chain would let any client forge an address and get a fresh
quota, which makes a per-IP limit decorative.

**Spam.** A hidden honeypot field plus a fill-time heuristic against the `rendered_at` stamp. A blocked
submission gets a response byte-identical to a success and nothing is stored — telling a bot which
control it tripped is free tuning information for whoever wrote it. (This is not theoretical: it caught
our own `render-check` script, which submitted too fast and got a green tick with no row.)

**Enrichment.** `ip-api.com` then `ipapi.co`, each with a timeout. Every provider has a
`live | mock_ok | down` mode, so the fallback proof is deterministic instead of depending on a third
party being up. `enrichIp` has no throw path.

**Side effects.** The confirmation is a row in `side_effect_jobs`, written in the same transaction as the
submission, and drained by a worker with exponential backoff and a dead-letter alert. This satisfies
"a failing email must not block the submission" structurally rather than by remembering a `try/catch`,
and it is the required background job.

---

## Testing and verification

```bash
npm test                # 57 tests: CORS preflight, invalid payloads, rate limiting,
                        # spam controls, provider fallback, side-effect failure,
                        # idempotency, tenant isolation, cache headers
npm run render-check    # loads the real second-origin page, asserts the widget renders and submits
npm run dashboard-check # drives the dashboard page and asserts the tables fill
```

The suite creates and migrates its own `widgets_test` database, pins the geo providers to mock modes, and
runs in one process so the shared rate-limiter state stays predictable. It needs Postgres up
(`docker compose up -d db`).

Every requirement in the brief has a pasted transcript in **[EVIDENCE.md](EVIDENCE.md)**, and the two
`*-check` scripts are committed precisely because that file cites their output.

---

## Limitations — the honest list

- **Rate limiting is in-process memory, not Redis.** Correct for one API container and far easier to
  prove, but limits reset on restart and are not shared across replicas. Horizontal scaling needs a
  shared store first.
- **The widget bundle is unminified and unbundled**, served as a single hand-written ES5-style file. Fine
  at ~10 KB; a real product would add a build step (a listed stretch goal, deliberately not done).
- **Only the current bundle version is kept.** A request for an older version gets current code with
  `no-cache` rather than the bytes that URL originally described. A real CDN would retain old assets.
- **The dashboard is one static page with no build step**, exactly as the brief allows. It is a way to
  see the endpoints working, not a product surface.
- **No email deliverability.** The default transport logs to the console; Mailpit is wired up for a
  realistic SMTP path. Nothing is sent to a real inbox.
- **The fill-time heuristic assumes a client that sends `rendered_at`.** A bot that omits it skips that
  check and faces only the honeypot. Tightening this means requiring a signed token — a stretch goal.
- **Widget deletion is a hard delete**, cascading to submissions. A real product would soft-delete so a
  misclick cannot destroy a customer's leads.
- **jsdom is not a browser.** `render-check` proves the widget renders and submits; it does not enforce
  CORS. The CORS proof is the header transcripts in EVIDENCE.md.
- **Single-region, single-process, no metrics backend.** Logs are structured JSON on stdout; there is no
  tracing or dashboarding beyond what the stats endpoint computes.

---

## Repository map

| Path | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | The one-page design written before the code, with the explicit non-goal |
| [EVIDENCE.md](EVIDENCE.md) | One pasted proof per requirement in Section 6 of the brief |
| [BUILDLOG.md](BUILDLOG.md) | Honest AI-usage log: what it wrote, what it got wrong, what I changed |
| [capstone.yaml](capstone.yaml) | Evaluator manifest — run / seed / test commands and endpoints |
| [.env.example](.env.example) | Every environment variable, with safe placeholders |
| [migrations/](migrations/) | Plain SQL, applied in order by [scripts/migrate.js](scripts/migrate.js) |
| [public/widget/bundle.js](public/widget/bundle.js) | The widget that runs on sites we do not control |
| [public/site/](public/site/) | The pretend customer website (template; the seed writes the real page) |
| [public/dashboard/](public/dashboard/) | The owner dashboard page |
| [tests/](tests/) | The deterministic suite |

**Secrets never enter the repository.** `.env` is git-ignored, `.env.example` carries placeholders only,
and the logger redacts keys matching `password`, `token`, `authorization`, `secret`, and friends before
anything reaches stdout.

## Licence

MIT — see [LICENSE](LICENSE).
