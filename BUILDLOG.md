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
