# EVIDENCE

One pasted proof per requirement checkbox in Section 6 of the brief. Filled in as each stage lands —
every transcript below is real command output, copied unedited.

> Status: skeleton. Proofs are added stage by stage; the final self-check ticks every box.

## Widget management
- [ ] Authenticated CRUD endpoints for widgets; requests without valid auth are rejected.
- [ ] Multi-tenant isolation proven: tenant A cannot read or modify tenant B's widgets or submissions.
- [ ] Embed snippet generated per widget.

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
