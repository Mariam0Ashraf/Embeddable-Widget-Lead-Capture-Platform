# EVIDENCE

One pasted proof per requirement checkbox in Section 6 of the brief. Filled in as each stage lands —
every transcript below is real command output, copied unedited.

> Status: in progress. Proofs are added stage by stage; the final self-check ticks every box.

## Environment the proofs were captured in

```
$ docker compose ps
NAME                                        IMAGE                STATUS                   PORTS
embeddablewidgetlead-captureplatform-db-1   postgres:16-alpine   Up 56 seconds (healthy)  0.0.0.0:5433->5432/tcp

$ npm run migrate
{"level":"info","message":"migration applied","file":"001_init.sql"}

$ docker compose exec db psql -U widget -d widgets -c "\dt"
 public | schema_migrations | table | widget
 public | side_effect_jobs  | table | widget
 public | submissions       | table | widget
 public | tenants           | table | widget
 public | users             | table | widget
 public | widgets           | table | widget
(6 rows)
```

Schema is applied as migrations, with the indexes the design called for
(shared requirement #4, "real persistence"):

```
$ docker compose exec db psql -U widget -d widgets -c "\d submissions"
Indexes:
    "submissions_pkey" PRIMARY KEY, btree (id)
    "submissions_tenant_created_idx" btree (tenant_id, created_at DESC)
    "submissions_widget_created_idx" btree (widget_id, created_at DESC)
    "submissions_widget_idempotency_key" UNIQUE, btree (widget_id, idempotency_key)
                                         WHERE idempotency_key IS NOT NULL
```

## Widget management

- [x] **Authenticated CRUD endpoints for widgets; requests without valid auth are rejected.**

```
--- GET /api/widgets with no token -> 401 ---
401 {"error":"unauthorized","message":"Missing Bearer token"}

--- GET /api/widgets with a garbage token -> 401 ---
401 {"error":"unauthorized","message":"Invalid authentication token"}

--- A creates a widget -> 201 ---
201 {"id":"606cf532-fe51-40c4-b284-7cf7b296b06e","public_id":"y6884z5s8gdh",
     "tenant_id":"b408b995-90d6-4a95-aa63-b6c8275f1106","type":"signup_form",
     "title":"Newsletter signup","button_text":"Subscribe",
     "display":{"theme":"light","position":"inline","delay_ms":0,
                "success_message":"Thanks — we got it."},
     "allowed_origins":["http://localhost:5500"],"config_version":1}

--- PATCH bumps config_version ---
200 title= Newsletter v2 version= 2

--- DELETE own widget -> 204 ---
204
```

Bad input is a clean 4xx with per-field detail, never a 500 — including a non-UUID
path parameter, which would otherwise reach Postgres as invalid input:

```
--- invalid widget payload -> 400 with details ---
400 {"error":"validation_failed","details":[
      {"field":"type","message":"Invalid option: expected one of \"signup_form\"|…"},
      {"field":"title","message":"Too small: expected string to have >=1 characters"},
      {"field":"fields.0.name","message":"Field name must be lowercase letters, digits …"}]}

--- unknown key rejected (strict schema) -> 400 ---
400 {"error":"validation_failed","details":[{"field":"(body)","message":"Unrecognized key: \"sneaky\""}]}

--- empty PATCH -> 400 ---
400 {"error":"validation_failed","details":[{"field":"(body)","message":"Provide at least one field to update"}]}

--- non-uuid id -> 404 not 500 ---
404 {"error":"not_found","message":"Widget not found"}
```

- [x] **Multi-tenant isolation proven: tenant A cannot read or modify tenant B's widgets or submissions.**

Two tenants registered; every cross-tenant attempt on A's widget id, made with B's
valid token, is refused. The response is `404`, not `403` — a `403` would confirm the
widget exists, which is itself a leak across the boundary.

```
--- TENANT ISOLATION: B reads A's widget -> 404 ---
404 {"error":"not_found","message":"Widget not found"}

--- TENANT ISOLATION: B patches A's widget -> 404 ---
404 {"error":"not_found","message":"Widget not found"}

--- TENANT ISOLATION: B deletes A's widget -> 404 ---
404 {"error":"not_found","message":"Widget not found"}

--- TENANT ISOLATION: B's list is empty, A's is not ---
B total: 0 | A total: 1

--- A still owns an untouched widget ---
200 title= Newsletter signup version= 1 origins= ["http://localhost:5500"]
```

Submission-side isolation is proven in the dashboard section, once submissions exist.

- [x] **Embed snippet generated per widget.**

```
--- embed snippet ---
200 {"public_id":"y6884z5s8gdh",
     "script_url":"http://localhost:3000/widget.js?id=y6884z5s8gdh",
     "config_url":"http://localhost:3000/api/public/widgets/y6884z5s8gdh/config",
     "submit_url":"http://localhost:3000/api/public/submissions",
     "snippet":"<script src=\"http://localhost:3000/widget.js?id=y6884z5s8gdh\" async></script>"}
```

## Widget delivery
- [ ] Public config endpoint serves a small payload with correct HTTP cache headers.
- [ ] Widget JavaScript is served as a versioned bundle.
- [ ] The widget renders on a page served from a different origin than the API.

## Public submission API
- [ ] Cross-origin submissions work: CORS headers correct, preflight (OPTIONS) handled.
- [ ] All incoming input validated; malformed and oversized payloads rejected with 4xx + JSON errors.
- [ ] Valid submissions stored safely, linked to the right widget and tenant.

## Abuse protection
- [ ] Rate limiting returns 429 under a burst — and the API keeps serving legitimate traffic.
- [ ] At least one spam-prevention technique demonstrably blocks a spam submission.

## Enrichment & safe side effects
- [ ] Provider fallback chain: provider A down → provider B answers → submission enriched.
- [ ] All providers down → submission still succeeds (without geo).
- [ ] A failing confirmation email / webhook does not prevent the submission from being stored.

## Documentation
- [ ] README with architecture diagram, setup instructions, and API documentation; required files present.
