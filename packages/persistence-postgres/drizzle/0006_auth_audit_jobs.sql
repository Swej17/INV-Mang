-- Sessions, roles, audit trail, and the job queue.
--
-- NUMBERING: 0005 is deliberately reserved for orders/packing, which Task 8 did
-- not deliver. A gap is safe here because orders/packing depends only on items
-- (0002) and nothing in this file, so applying it later in lexical order cannot
-- break either.

CREATE TABLE IF NOT EXISTS organizations (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    time_zone   text NOT NULL DEFAULT 'America/New_York',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL REFERENCES organizations (id),
    email             text NOT NULL,
    /* Identity lives with the auth provider; this is only the local mapping. */
    external_subject  text,
    role              text NOT NULL DEFAULT 'OWNER_ADMIN',
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_email_unique UNIQUE (organization_id, email),
    CONSTRAINT users_role_known CHECK (role IN ('OWNER_ADMIN', 'PRODUCTION', 'FULFILLMENT'))
);

-- Opaque server-side sessions. The browser only ever holds a random token in a
-- secure HTTP-only cookie: no identity, no role, no claims. A stolen cookie is
-- revocable here, which a self-describing token would not be.
CREATE TABLE IF NOT EXISTS sessions (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users (id),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    /* SHA-256 of the cookie value. The raw token is never stored, so a database
       leak cannot be replayed as a live session. */
    token_hash      text NOT NULL UNIQUE,
    /* Rotated per session; compared in constant time on state-changing requests. */
    csrf_token      text NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    user_agent      text,

    CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS sessions_live_idx
    ON sessions (token_hash) WHERE revoked_at IS NULL;

-- Append-only audit. Deliberately its own table rather than a column on each
-- record: "who changed this and why" must survive even when the record itself
-- is corrected by a compensating entry.
CREATE TABLE IF NOT EXISTS audit_events (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL,
    actor_id          uuid,
    /* Correlates every log line and audit row for one request. */
    request_id        text,
    kind              text NOT NULL,
    resource_type     text,
    resource_id       text,
    /* Redacted before it gets here; see the API's log redaction. */
    detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audit_events_kind_not_blank CHECK (length(trim(kind)) > 0)
);

CREATE INDEX IF NOT EXISTS audit_events_org_time_idx
    ON audit_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_events_reject_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_mutation ON audit_events;
CREATE TRIGGER audit_events_no_mutation
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

-- Job queue. PostgreSQL-backed on purpose: the design document rules out Redis
-- for a single-operator system, and a jobs table gets transactional consistency
-- with the ledger for free.
CREATE TABLE IF NOT EXISTS jobs (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL,
    kind              text NOT NULL,
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            text NOT NULL DEFAULT 'PENDING',
    run_after         timestamptz NOT NULL DEFAULT now(),
    /* Lease, not lock: a worker that dies simply lets the lease lapse. */
    leased_until      timestamptz,
    leased_by         text,
    attempts          integer NOT NULL DEFAULT 0,
    max_attempts      integer NOT NULL DEFAULT 5,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,

    CONSTRAINT jobs_status_known CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
    CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0),
    CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0),
    -- A RUNNING job without a lease can never be reclaimed: it would occupy the
    -- queue forever with no worker and no expiry.
    CONSTRAINT jobs_running_has_lease CHECK (status <> 'RUNNING' OR leased_until IS NOT NULL)
);

-- Matches the claim query exactly: pending work that is due, oldest first.
CREATE INDEX IF NOT EXISTS jobs_claimable_idx
    ON jobs (run_after, created_at) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS jobs_reclaimable_idx
    ON jobs (leased_until) WHERE status = 'RUNNING';
