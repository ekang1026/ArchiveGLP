-- Single-use pairing codes for device enrollment.
--
-- A firm admin creates a pending_enrollment row for an employee. The
-- employee runs `archiveglp-agent enroll` and enters the pairing_code.
-- The enroll Lambda atomically marks the row used and creates the
-- employee (if needed) + device rows. Codes expire and cannot be reused.
--
-- This is the bootstrap authentication step; from the next request
-- onward the device signs requests with its registered public key.

BEGIN;

CREATE TABLE pending_enrollment (
    pairing_code        TEXT PRIMARY KEY,
    firm_id             TEXT NOT NULL REFERENCES firm(firm_id),
    employee_id         TEXT NOT NULL,
    employee_email      TEXT NOT NULL,
    employee_full_name  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ,
    used_by_device_id   TEXT
);

CREATE INDEX ON pending_enrollment (firm_id, employee_id);
CREATE INDEX ON pending_enrollment (expires_at) WHERE used_at IS NULL;

COMMIT;
