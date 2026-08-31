# BUILDLOG — AI usage, honestly

The rule for this file: where AI helped, where it was wrong, what I changed. Newest entry at the bottom.
I can explain any 2–3 lines in this repository; anything I could not explain was rewritten until I could.

## Stage 1 — repo skeleton + design doc

**What AI did.** Drafted `DESIGN.md`, `.env.example`, `capstone.yaml`, `.gitignore`, and this file from
the capstone brief.

**What I kept.** The layer split (`http / services / repositories / lib`) and the transactional-outbox
shape for the side effect. Both are the patterns the brief's shared requirements ask for, and the outbox
happens to satisfy two requirements at once — "≥1 background job" and "a failing side effect must not
block the submission" — which is why it beat a plain `try { sendEmail() } catch {}`.

**What I changed.**
- The first draft used the widget's internal UUID in the embed URL. I split `public_id` off from `id`, so
  the public surface is opaque, non-enumerable, and rotatable without touching foreign keys.
- The first draft's geo enrichment called the real APIs in every environment. The brief explicitly wants
  the fallback proof to be deterministic, so each provider got a `live | mock_ok | down` mode instead.
- The draft's non-goal was a vague "keep the frontend simple". A non-goal that cannot be violated is
  useless, so it became a hard one: **no visual widget builder, no hosted customer frontend.**

**Where I was still unsure.** Whether to enforce tenancy in the repository layer or in the service layer.
I put it in the repository (every query takes `tenant_id` as a required argument) because a service-layer
check is one forgotten `if` away from a data leak, while a repository that cannot build a query without a
tenant id fails closed.

## Stage 2 — foundation: compose, migrations, config, logging, health

**What AI did.** Scaffolded `package.json`, `Dockerfile`, `docker-compose.yml`, the SQL migration, the
migration runner, and the `src/lib` + `src/http` skeleton.

**What I kept.** Migrations as plain `.sql` files with a ~50-line runner instead of an ORM or a migration
framework. The brief asks for "schema as migrations"; a dependency that hides the SQL would have made the
indexes harder to justify in a review, not easier.

**What I changed.**
- The generated config file read `process.env` directly at each use site. I moved it to one Zod-parsed,
  frozen `config` object that exits the process on a bad value, so a missing `JWT_SECRET` is a boot
  failure with a named variable instead of a 500 an hour later. The error prints the variable name only,
  never the value.
- The generated logger printed whole objects. Since submissions and auth bodies flow through this code,
  I added key-based redaction (`password`, `token`, `authorization`, …) before anything reaches stdout —
  shared requirement #6 says secrets are never logged, and "I'll remember not to log it" is not a control.
- The generated error handler let body-parser's errors fall through to the 500 branch. Those are client
  mistakes: `entity.too.large` now maps to 413 and `entity.parse.failed` to 400. This is exactly PROBE 2,
  and it would have failed.
- The generated `Dockerfile` ran only `npm start`. Migrations now run at boot in the same command, so
  `docker compose up` really is the single documented command a stranger needs.

**Where I was still unsure.** `trust proxy`. Setting it to `true` trusts the entire `X-Forwarded-For`
chain, which lets any client claim any IP and walk straight through a per-IP rate limit. I set it to `1`
— trust exactly the one hop we actually have (Docker/compose) and no further.

## Stage 3 — auth, tenant-isolated widget CRUD, embed snippet

**What AI did.** Wrote the auth service, the JWT helpers, the widget repository/service/route trio, and
the Zod schemas for widget creation and patching.

**What I kept.** 404-not-403 for another tenant's widget id. A `403` tells the caller "this exists but
isn't yours", which is a small leak across exactly the boundary the brief asks me to prove.

**What I changed.**
- The generated `login` returned early when the email was unknown. That makes the response measurably
  faster for unregistered addresses and turns login into an account-enumeration oracle. It now compares
  against a dummy hash and returns the identical error either way.
- The generated `register` trusted its own "does this email exist" check. Two simultaneous registrations
  race straight past it, so the unique index is the real guard; the `23505` violation is now translated
  to a 409 instead of surfacing as a 500.
- The generated route handlers passed `req.params.id` straight into SQL. A non-UUID reaches Postgres as
  invalid input and comes back a 500 — a validation box the brief grades. Ids are shape-checked before
  any query runs.
- I made every widget schema `.strict()`. A silently ignored unknown key is a customer filing a bug about
  a setting that "doesn't work" when it was never applied.

**Where the AI was wrong, and the probe caught it.** `display: displaySchema.default({})` looked correct
and passed review. It isn't: Zod's `.default()` stores the literal `{}` and never runs the inner schema,
so every widget was persisted with an empty display object and the public config would have shipped no
position, theme, or success message. The end-to-end probe printed `"display":{}` and gave it away.
Changed to `.prefault({})`, which parses the value and applies the nested defaults. This is the reason I
run a real request against a real database at the end of each stage instead of trusting the schema to
mean what it reads like.

**An environment fix, not a code fix.** `npm run migrate` failed with `password authentication failed for
user "widget"` while the container was healthy and `psql` worked *inside* it. A Postgres already running
on the host owned port 5432 and won over Docker's port proxy, so the client was talking to the wrong
server. The container is now published on **5433**, which also means the repo will not collide on a
reviewer's machine.

## Stage 4 — the hardened submission path

**What AI did.** Wrote the rate limiter, the geo provider chain, the spam checks, the submission
validator and service, the outbox worker, and the public CORS middleware.

**What I kept.** The transactional outbox. The submission row and its follow-up job are written in one
transaction, so there is no state where we keep a lead and silently forget to email them, and the worker
that drains it is the background job the shared requirements ask for.

**What I changed, and why each one is a real bug and not a style preference.**

- *CORS was registered after the body parser.* That looks harmless and is the single most misleading bug
  in this kind of system: a 413 or a malformed-JSON 400 comes back with no `Access-Control-Allow-Origin`,
  the browser refuses to show the response, and the customer's developer sees "blocked by CORS" for what
  is actually a clean, correct 413. It is now mounted before `express.json`, and the evidence transcript
  records the header on every 4xx.
- *The origin allow-list was enforced only by the CORS header.* CORS is a browser courtesy — `curl`
  ignores it completely — so that is not access control. The allow-list is now checked again in the
  service layer and returns 403.
- *Preflight was going to be answered per-widget.* It cannot be: an `OPTIONS` request has no body, so
  there is no way to know which widget is being addressed. Preflight is answered for any origin and the
  per-widget check happens on the POST.
- *The generated limiter never evicted keys.* One entry per IP ever seen, forever — a leak that only
  appears in production. Added a sweeper on an `unref`'d interval.
- *`trust proxy` interacts with rate limiting.* With `trust proxy: true` a client can put anything in
  `X-Forwarded-For` and get a fresh quota per forged address, which makes the per-IP limit decorative.
  Kept at one hop.
- *The honeypot originally returned a 400.* That tells the bot exactly which control it tripped, which is
  free tuning information for whoever wrote it. It now returns a response indistinguishable from success
  and stores nothing; the row count in `EVIDENCE.md` is what proves the drop.
- *The timing heuristic treated a missing `rendered_at` as spam.* That would reject the reviewer's `curl`
  and every server-to-server caller. It now only applies when the stamp is present, and a stamp from the
  future is treated as forged.

**Where I was wrong, not the AI.** My first worker probe claimed to prove the dead-letter path and proved
nothing: a backlog of pending jobs from earlier probe runs filled every batch of five, so the job I was
watching was never claimed and sat at `attempts: 0` while I read the log as success. The fix was to park
the backlog and re-run against a single job. Worth writing down because the failure mode — a green-looking
log that never touched the thing under test — is exactly what a careless `EVIDENCE.md` would have enshrined.

**A design note I want to be able to defend.** The rate limiter is in-process memory, not Redis. For one
API container that is exactly as correct and far easier to prove, but it means limits reset on restart and
would not be shared across replicas. That is a real limitation, so it goes in the README's limitations
section rather than being quietly hoped over.

## Stage 5 — widget delivery: loader, versioned bundle, cached config, customer site

**What AI did.** Wrote the widget bundle, the loader generator, the delivery routes, the seed script, the
static site server, and the render check.

**What I kept.** Splitting the loader from the bundle. The loader is per-widget and short-lived; the
bundle is one immutable file shared by every widget on every site. That is the shape a CDN wants, and it
means a release reaches customers in minutes without anyone re-downloading the payload.

**What I changed.**
- *The bundle version was going to be the `WIDGET_BUILD_VERSION` env var alone.* Then `immutable` is a
  lie the first time somebody edits `bundle.js` and forgets to bump the number, and browsers cache stale
  code for a year. The URL now carries a hash of the file's actual bytes, so the version cannot drift
  from the content.
- *A stale bundle URL was going to 404.* The loader is cached for five minutes, so for five minutes after
  a release some pages still ask for the old URL — and a 404 there is a customer's form silently
  disappearing. Unknown versions now serve current code with `no-cache`: the page keeps working, and
  nothing is ever cached under a URL that misdescribes its contents.
- *The public config was built by deleting keys from the widget row.* A deny-list leaks whatever column
  gets added next. It is now an explicit allow-list, and it deliberately omits `allowed_origins` — 
  publishing that would hand an attacker the exact `Origin` header to forge.
- *The bundle used `innerHTML` for titles and labels.* Those are customer-authored strings rendered on
  someone else's page; the bundle now builds nodes and sets `textContent`, so a customer cannot inject
  markup into their own visitors' pages through us.
- *The widget id was read from `document.currentScript`.* That is unreliable once a tag has been moved,
  copied, or injected by a tag manager. The id is baked into the loader server-side instead.

**Where I was wrong, and the system caught me.** The render check passed on its first run — green ticks,
success message, `POST … -> 201` in the log — and there was **no row in the database**. The check filled
and submitted the form in the same tick, which is precisely the definition of a bot that the fill-time
heuristic exists to catch, so the submission was silently dropped. It looked like success because the
spam response is *designed* to be indistinguishable from success. My own anti-spam control fooled my own
test, which is the strongest evidence I have that it works. The check now waits out
`SPAM_MIN_FILL_MS` before submitting, and asserts the row exists rather than trusting the 201.

**A limitation I am stating rather than hiding.** jsdom is not a browser and does not enforce CORS, so
`render-check` is not the CORS proof — the preflight transcripts are. It proves the other half: that one
`<script>` tag on a foreign page becomes a working, submitting form.

## Stage 6 — owner dashboard API

**What AI did.** Wrote the dashboard repository, service, routes, and the single-file dashboard page.

**What I kept.** Denormalising `tenant_id` onto the submission row, decided back in the design. Every
dashboard query now starts its `WHERE` with `s.tenant_id = $1` and never has to join through `widgets` to
know who owns a lead. That is what makes the isolation proof strong rather than incidental: even when
tenant B passes tenant A's `widget_id` as an explicit filter, the filter can only narrow B's own rows.

**What I changed.**
- *The day-series was a plain `GROUP BY date_trunc`.* That silently omits days with no submissions, so a
  chart drawn from it closes the gaps and makes a quiet week look busy. It now generates the date series
  and left-joins, so a quiet day is a `0`.
- *The country breakdown dropped rows whose enrichment failed.* Convenient, and dishonest: it would make
  the geo feature look like it works far more often than it does. Failed rows are counted as `unknown`,
  and there is a separate `by_enrichment` block that shows which provider carried each lead.
- *`enrichment_rate` divided by the total without guarding it.* A brand-new tenant has zero submissions,
  so the first thing they would ever see on their dashboard is `NaN%`.
- *The generated dashboard page put the JWT in `localStorage` and built rows with `innerHTML`.* It is a
  short-lived credential with no reason to outlive the tab, so it moved to `sessionStorage`; and the rows
  contain submitted data from the public internet, which is the last string in this system that should
  ever be parsed as HTML. The table builder creates nodes and sets `textContent`.
- *A 401 left the stale page on screen.* An expired token now drops the user back to the sign-in form
  instead of showing numbers that are no longer authorised.

**Where I was wrong.** My first dashboard probe seeded its test submissions against `widgets[0]`, which
sorts newest-first and was the *contact* widget — so every seeded submission failed validation with a 400
for a missing `message` field, and I nearly read the resulting "total: 1" as a working dashboard. The
lesson is the same one as Stage 5: assert on the thing you meant to create, not on the status code you
hoped for.

**On the checking scripts.** `render-check` and `dashboard-check` are committed scripts, not throwaway
probes, precisely because `EVIDENCE.md` cites their output. A pasted transcript nobody can reproduce is
just a screenshot in a monospace font.
