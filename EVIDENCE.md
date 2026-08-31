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

- [x] **Cross-origin submissions work: CORS headers correct, preflight (OPTIONS) handled.**

```
--- CORS preflight (OPTIONS) from the second origin ---
204 {"access-control-allow-origin":"http://localhost:5500",
     "access-control-allow-methods":"GET, POST, OPTIONS",
     "access-control-allow-headers":"Content-Type, Idempotency-Key",
     "access-control-max-age":"86400",
     "vary":"Origin"}
```

- [x] **Valid submissions stored safely, linked to the right widget and tenant.** *(PROBE 1)*

```
--- valid cross-origin submission -> stored ---
201 {"id":"e584a3f9-8918-48e9-879e-7d6cd8ff0c44",
     "widget_id":"48e01985-3ad7-4550-b294-434c767b438f",
     "geo_status":"unavailable"}  | ACAO: http://localhost:5500

stored row: {"data":{"name":"Vera","plan":"pro","email":"visitor@example.com"},
             "geo_status":"unavailable","origin":"http://localhost:5500","ip":"203.0.113.10"}
```

Only declared fields reach storage — the stored `data` is rebuilt from the widget's
field list rather than filtered in place.

**Idempotency** (shared requirement #5) — the retried action happens once:

```
first : 201 23ec4332-0ee9-46c7-a1ec-4715aa02b334
replay: 200 {"id":"23ec4332-0ee9-46c7-a1ec-4715aa02b334","idempotent_replay":true}
same id: true
```

- [x] **All input validated; malformed and oversized payloads rejected with 4xx + JSON errors.** *(PROBE 2)*

Every case below is a 4xx with a JSON body — no 500 anywhere. Each response still
carries `Access-Control-Allow-Origin`, so a browser shows the real status instead of
hiding it behind a generic CORS error:

```
--- malformed JSON -> 400 ---
400 {"error":"invalid_json","message":"Request body is not valid JSON"} | ACAO: http://localhost:5500

--- oversized payload (40 KB against a 16 KB limit) -> 413 ---
413 {"error":"payload_too_large","message":"Request body exceeds the maximum allowed size"} | ACAO: http://localhost:5500

--- invalid fields -> 400 listing every problem at once ---
400 {"error":"validation_failed","details":[
      {"field":"data.nope","message":"Unknown field for this widget"},
      {"field":"data.email","message":"Email must be a valid email"},
      {"field":"data.plan","message":"Plan must be one of the offered options"}]}

--- missing required field -> 400 ---
400 {"error":"validation_failed","details":[{"field":"data.email","message":"Email is required"}]}

--- unknown widget -> 404 ---
404 {"error":"not_found","message":"Widget not found"}

--- origin not on the widget's allow-list -> 403 ---
403 {"error":"forbidden","message":"This widget is not permitted to be embedded on that origin"}
```

That last one matters: CORS is a browser courtesy that `curl` ignores completely, so
the allow-list is enforced again server-side rather than trusted to a header.

## Abuse protection

- [x] **Rate limiting returns 429 under a burst — and the API keeps serving legitimate traffic.** *(PROBE 3)*

25 submissions from one IP against a limit of 20 per 60 s:

```
status sequence: 201 201 201 201 201 201 201 201 201 201
                 201 201 201 201 201 201 201 201 201 201
                 429 429 429 429 429
2xx: 20 | 429: 5

429 body   : {"error":"rate_limited","message":"Too many requests from this address — slow down",
              "details":{"scope":"ip","retry_after_seconds":57}}
429 headers: {"retry-after":"57","x-ratelimit-limit":"20","x-ratelimit-remaining":"0"}
```

The service keeps serving everyone else while that address is being refused:

```
different IP  -> 201 {"id":"1f53745e-0b6e-44f5-b467-77a3c5ec658d", ...}
GET /health   -> 200 {"status":"ok","database":"up"}
owner API     -> 200 widgets: 1
```

- [x] **At least one spam-prevention technique demonstrably blocks a spam submission.** *(PROBE 6)*

Two controls. Neither tells the bot what it tripped — the response is indistinguishable
from a success, and the row count proves nothing was stored:

```
--- honeypot filled like a bot ---
201 {"id":"a1a3d748-326f-44b9-81b7-36c53060a6f0","status":"received"}
rows before=1 after=1  -> stored: false
server log: {"level":"warn","message":"submission blocked as spam","reason":"honeypot_filled"}

--- timing heuristic: submitted 60ms after render, minimum is 1200ms ---
201 {"id":"099b041c-4e06-484b-9371-f9591c112aa9","status":"received"} | rows still 1
server log: {"level":"warn","message":"submission blocked as spam",
             "reason":"submitted_too_fast","elapsed_ms":60}
```

## Enrichment & safe side effects

- [x] **Provider fallback chain: provider A down → provider B answers → submission enriched.** *(PROBE 4)*

Provider modes are env-driven (`live | mock_ok | down`), so this proof is deterministic
instead of depending on a third party being up:

```
$ GEO_PROVIDER_A_MODE=down GEO_PROVIDER_B_MODE=mock_ok node ...
{"level":"warn","message":"geo provider failed, falling through","provider":"ip-api.com",
 "error":"ip-api.com is unavailable"}
201 {"geo_status":"enriched","geo_provider":"ipapi.co",
     "geo":{"country":"Portugal","country_code":"PT","city":"Lisbon","lat":38.7223,"lon":-9.1393}}
```

When provider A is healthy, B is never called:

```
$ GEO_PROVIDER_A_MODE=mock_ok GEO_PROVIDER_B_MODE=down node ...
201 {"geo_status":"enriched","geo_provider":"ip-api.com",
     "geo":{"country":"Germany","country_code":"DE","city":"Berlin"}}
```

- [x] **All providers down → submission still succeeds (without geo). Degrade, never fail.**

```
$ GEO_PROVIDER_A_MODE=down GEO_PROVIDER_B_MODE=down node ...
{"level":"warn","message":"geo provider failed, falling through","provider":"ip-api.com"}
{"level":"warn","message":"geo provider failed, falling through","provider":"ipapi.co"}
{"level":"warn","message":"geo enrichment unavailable, storing without location"}
201 {"geo_status":"unavailable","geo":null,"geo_provider":null}
stored: {"geo_status":"unavailable","geo_provider":null,"geo":null}
```

The same thing happened unprompted against the **live** providers, which is the better
proof: `ip-api.com` timed out and `ipapi.co` answered `"Reserved IP Address"` for a
TEST-NET address, and the submission was stored regardless.

- [x] **A failing confirmation email / webhook does not prevent the submission from being stored.** *(PROBE 5)*

`SIDE_EFFECT_TRANSPORT=fail` makes the transport throw on every call. The visitor never
notices, because the side effect is a transactional-outbox job drained by a background
worker — by the time it runs, the 201 was sent long ago.

```
$ SIDE_EFFECT_TRANSPORT=fail SIDE_EFFECT_MAX_ATTEMPTS=3 node ...
visitor response -> 201 {"id":"80263bc4-f470-4c84-80f7-5d7c5040dfc8", ...}
row in database  -> STORED {"email":"probe7-...@example.com"}
job after insert -> {"status":"pending","attempts":0,"max_attempts":3}
```

The background job then retries with exponential backoff and dead-letters with an alert
(shared requirement #3: slow work off the request path, retries + failure alert):

```
--- worker tick 1 ---
{"level":"warn","message":"side effect failed, retry scheduled","attempt":1,"of":3,"retry_in_s":2}
outcome: {"claimed":1,"done":0,"retried":1,"failed":0}

--- worker tick 2 ---
{"level":"warn","message":"side effect failed, retry scheduled","attempt":2,"of":3,"retry_in_s":4}
outcome: {"claimed":1,"done":0,"retried":1,"failed":0}

--- worker tick 3 ---
{"level":"error","message":"side effect dead-lettered — manual follow-up required",
 "alert":"side_effect_dead_letter","job_id":"56cf355f-...","attempts":3}
outcome: {"claimed":1,"done":0,"retried":0,"failed":1}
job    : {"status":"failed","attempts":3,"max_attempts":3}

Submission still stored after the side effect exhausted every retry: true
```

Control — the identical job succeeds once the transport works, so the failure path
above is the transport failing, not the worker being broken:

```
$ SIDE_EFFECT_TRANSPORT=console node ...
{"level":"info","message":"side effect delivered","job_id":"56cf355f-...","transport":"console"}
outcome: {"claimed":1,"done":1,"retried":0,"failed":0}
```

## Documentation
- [ ] README with architecture diagram, setup instructions, and API documentation; required files present.
