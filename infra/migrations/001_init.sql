-- ArchiveGLP metadata schema (Aurora Postgres).
--
-- This database is NOT the system of record. S3 (Object Lock, Compliance mode)
-- is the system of record. This schema holds searchable metadata, supervisor
-- review state, device health, and audit rows. It must be rebuildable from S3
-- in a disaster.

BEGIN;

CREATE TABLE firm (
    firm_id            TEXT PRIMARY KEY,
    display_name       TEXT NOT NULL,
    retention_years    SMALLINT NOT NULL CHECK (retention_years >= 3),
    legal_hold_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee (
    employee_id  TEXT PRIMARY KEY,
    firm_id      TEXT NOT NULL REFERENCES firm(firm_id),
    email        TEXT NOT NULL,
    full_name    TEXT NOT NULL,
    enrolled_at  TIMESTAMPTZ,
    active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX ON employee (firm_id);

CREATE TABLE device (
    device_id            TEXT PRIMARY KEY,
    firm_id              TEXT NOT NULL REFERENCES firm(firm_id),
    employee_id          TEXT NOT NULL REFERENCES employee(employee_id),
    public_key_spki_b64  TEXT NOT NULL,
    os_version           TEXT,
    agent_version        TEXT,
    enrolled_at          TIMESTAMPTZ NOT NULL,
    last_heartbeat_at    TIMESTAMPTZ,
    last_captured_at     TIMESTAMPTZ,
    status               TEXT NOT NULL DEFAULT 'healthy',
    queue_depth          INTEGER NOT NULL DEFAULT 0,
    clock_skew_ms        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ON device (employee_id);
CREATE INDEX ON device (firm_id, last_heartbeat_at);

-- Per-firm monotonic archive sequence. One DB per firm (one AWS account per firm).
CREATE SEQUENCE archive_seq START 1;

CREATE TABLE message_meta (
    archive_seq       BIGINT PRIMARY KEY,
    message_id        TEXT NOT NULL,
    firm_id           TEXT NOT NULL REFERENCES firm(firm_id),
    employee_id       TEXT NOT NULL REFERENCES employee(employee_id),
    device_id         TEXT NOT NULL REFERENCES device(device_id),
    source            TEXT NOT NULL,
    conversation_id   TEXT NOT NULL,
    direction         TEXT NOT NULL,
    from_handle       TEXT NOT NULL,
    to_handles        TEXT[] NOT NULL,
    body_text         TEXT NOT NULL DEFAULT '',
    unsent            BOOLEAN NOT NULL DEFAULT FALSE,
    captured_at       TIMESTAMPTZ NOT NULL,
    ingested_at       TIMESTAMPTZ NOT NULL,
    archived_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    s3_bucket         TEXT NOT NULL,
    s3_key            TEXT NOT NULL,
    body_text_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', body_text)) STORED,
    UNIQUE (firm_id, message_id)
);
CREATE INDEX ON message_meta (firm_id, captured_at DESC);
CREATE INDEX ON message_meta (firm_id, employee_id, captured_at DESC);
CREATE INDEX ON message_meta (firm_id, conversation_id, captured_at DESC);
CREATE INDEX ON message_meta USING GIN (body_text_tsv);

CREATE TABLE attachment_meta (
    archive_seq  BIGINT NOT NULL REFERENCES message_meta(archive_seq) ON DELETE CASCADE,
    idx          SMALLINT NOT NULL,
    sha256       TEXT NOT NULL,
    mime         TEXT NOT NULL,
    bytes        BIGINT NOT NULL,
    s3_bucket    TEXT NOT NULL,
    s3_key       TEXT NOT NULL,
    PRIMARY KEY (archive_seq, idx)
);

-- Supervisor actions (view, search, export) and system events.
-- Every row is ALSO archived to S3 under the firm's retention; the
-- s3_* columns point to that durable copy (populated by the archiver).
CREATE TABLE audit_log (
    audit_seq    BIGSERIAL PRIMARY KEY,
    firm_id      TEXT NOT NULL REFERENCES firm(firm_id),
    actor_type   TEXT NOT NULL CHECK (actor_type IN ('supervisor', 'd3p', 'system')),
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    metadata     JSONB,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    s3_bucket    TEXT,
    s3_key       TEXT
);
CREATE INDEX ON audit_log (firm_id, occurred_at DESC);
CREATE INDEX ON audit_log (firm_id, actor_id, occurred_at DESC);

COMMIT;
