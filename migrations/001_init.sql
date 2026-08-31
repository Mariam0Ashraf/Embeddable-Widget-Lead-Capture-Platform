-- Initial schema: tenants, users, widgets, submissions, and the side-effect outbox.

CREATE TABLE tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email         text        NOT NULL,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Emails are compared case-insensitively, so uniqueness must be too.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_tenant_id_idx ON users (tenant_id);

CREATE TABLE widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Opaque id used in the public embed URL. Deliberately not the primary key:
    -- the public surface stays non-enumerable and can be rotated.
    public_id       text        NOT NULL,
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    type            text        NOT NULL CHECK (type IN ('signup_form', 'contact_form', 'cta', 'popover')),
    title           text        NOT NULL,
    description     text,
    fields          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    button_text     text        NOT NULL DEFAULT 'Submit',
    display         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Empty array means "any origin may embed this widget".
    allowed_origins text[]      NOT NULL DEFAULT '{}',
    config_version  integer     NOT NULL DEFAULT 1,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX widgets_public_id_key ON widgets (public_id);
CREATE INDEX widgets_tenant_id_idx ON widgets (tenant_id, created_at DESC);

CREATE TABLE submissions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    widget_id       uuid        NOT NULL REFERENCES widgets (id) ON DELETE CASCADE,
    -- Denormalised so every dashboard query can filter by tenant without a join.
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    data            jsonb       NOT NULL,
    ip              inet,
    user_agent      text,
    referer         text,
    origin          text,
    geo             jsonb,
    geo_provider    text,
    -- enriched | unavailable | skipped
    geo_status      text        NOT NULL DEFAULT 'skipped',
    idempotency_key text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_tenant_created_idx ON submissions (tenant_id, created_at DESC);
CREATE INDEX submissions_widget_created_idx ON submissions (widget_id, created_at DESC);

-- A retried POST carrying the same Idempotency-Key must not create a second row.
CREATE UNIQUE INDEX submissions_widget_idempotency_key
    ON submissions (widget_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Transactional outbox. The row is written in the same transaction as the
-- submission; a worker drains it afterwards, so a dead SMTP host or webhook
-- can never fail the visitor's request.
CREATE TABLE side_effect_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id   uuid        NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    type            text        NOT NULL,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- pending | processing | done | failed
    status          text        NOT NULL DEFAULT 'pending',
    attempts        integer     NOT NULL DEFAULT 0,
    max_attempts    integer     NOT NULL DEFAULT 3,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX side_effect_jobs_claim_idx ON side_effect_jobs (status, next_attempt_at);
CREATE INDEX side_effect_jobs_submission_idx ON side_effect_jobs (submission_id);
