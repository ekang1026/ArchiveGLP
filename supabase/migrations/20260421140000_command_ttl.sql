-- Command TTL + supervisor-visible expiry.
--
-- Previously a `revoke` queued months ago for a device in a drawer
-- would fire the moment that device powered back on, because nothing
-- aged commands out. A misclicked remediation had no way to harmlessly
-- expire; you had to remember to cancel it.
--
-- After: every command carries `expires_at`. The GET /v1/commands
-- handler skips expired rows and the POST ack handler refuses to
-- accept acks for already-expired commands. A separate lazy reaper
-- (invoked on GET) marks expired-but-unfulfilled rows with
-- `error='expired'` so the supervisor-facing table shows why they
-- never ran.

alter table pending_command
    add column if not exists expires_at timestamptz
        not null
        default (now() + interval '24 hours');

-- Existing rows: already-finished rows keep their default but it's
-- harmless since we only filter on expires_at for completed_at IS NULL.
-- Any open (pre-migration) row also gets the 24h default from `now()`.

create index if not exists pending_command_device_expires_idx
    on pending_command (device_id, expires_at)
    where completed_at is null;
