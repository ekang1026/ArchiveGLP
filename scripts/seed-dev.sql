-- Dev seed: one firm, one supervisor-owned employee, six devices
-- covering every health state the dashboard can render, two sample
-- pending_command rows, and a handful of audit_log rows.
--
-- Idempotent: safe to re-run. Uses the firm_id `firm_archdev001`
-- which is the default in dev-bootstrap.sh + .env.example.
--
-- Apply with:
--   supabase db execute --file scripts/seed-dev.sql
--   # or: psql $DATABASE_URL -f scripts/seed-dev.sql
--
-- Then /devices in the dashboard should show six devices with the
-- full spectrum of colors (healthy, warning, silent, critical,
-- paused, revoked) and the /audit page should show a non-empty log.

-- A DO block keeps this as a single transactional unit.
do $$
declare
    _firm   text := 'firm_archdev001';
    _emp    text := 'emp_devseed0001';
    -- ECDSA P-256 SPKI base64 — dummy key material only used because
    -- public_key_spki_b64 is NOT NULL. These seeded devices can't
    -- actually authenticate; they're just for UI exercise.
    _pub    text := 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNA==';
    _now    timestamptz := now();
begin

insert into firm (firm_id, display_name, retention_years, legal_hold_default)
values (_firm, 'Dev Firm', 3, false)
on conflict (firm_id) do update
    set display_name = excluded.display_name;

insert into employee (employee_id, firm_id, email, full_name, enrolled_at, active)
values (_emp, _firm, 'you@example.com', 'Dev Supervisor', _now, true)
on conflict (employee_id) do update
    set email = excluded.email;

-- healthy: fresh heartbeat, fresh capture, every gauge nominal
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_healthy', _firm, _emp, _pub,
    'mac-healthy', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '7 days', _now - interval '30 seconds', _now - interval '2 minutes',
    'healthy', 0, 200, 8000,
    true, 'granted', 0,
    false, null
) on conflict (device_id) do update set
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_captured_at  = excluded.last_captured_at,
    disk_free_gb      = excluded.disk_free_gb,
    memory_free_mb    = excluded.memory_free_mb,
    queue_depth       = excluded.queue_depth,
    paused            = false,
    revoked_at        = null;

-- warning: disk low, heartbeat fresh
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_warning', _firm, _emp, _pub,
    'mac-warning', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '30 days', _now - interval '45 seconds', _now - interval '3 minutes',
    'degraded', 200, 5, 6000,
    true, 'granted', 0,
    false, null
) on conflict (device_id) do update set
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_captured_at  = excluded.last_captured_at,
    disk_free_gb      = excluded.disk_free_gb,
    paused            = false,
    revoked_at        = null;

-- silent: the exact scenario supervisors asked about — heartbeat
-- fresh but no captures for hours
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_silent', _firm, _emp, _pub,
    'mac-silent', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '14 days', _now - interval '20 seconds', _now - interval '6 hours',
    'healthy', 0, 150, 7000,
    true, 'granted', 0,
    false, null
) on conflict (device_id) do update set
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_captured_at  = excluded.last_captured_at,
    paused            = false,
    revoked_at        = null;

-- critical: heartbeat stale >30min
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_critical', _firm, _emp, _pub,
    'mac-critical', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '90 days', _now - interval '2 hours', _now - interval '2 hours',
    'offline', 42, 120, 5000,
    true, 'granted', 0,
    false, null
) on conflict (device_id) do update set
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_captured_at  = excluded.last_captured_at,
    paused            = false,
    revoked_at        = null;

-- paused: administrative state overrides all gauges
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_paused', _firm, _emp, _pub,
    'mac-paused', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '60 days', _now - interval '45 seconds', _now - interval '1 hour',
    'healthy', 0, 180, 8000,
    true, 'granted', 0,
    true, null
) on conflict (device_id) do update set
    last_heartbeat_at = excluded.last_heartbeat_at,
    paused            = true,
    revoked_at        = null;

-- revoked: de-enrolled, cannot receive further commands (except
-- re-revoke, which is idempotent)
insert into device (
    device_id, firm_id, employee_id, public_key_spki_b64,
    hostname, os_version, agent_version,
    enrolled_at, last_heartbeat_at, last_captured_at,
    status, queue_depth, disk_free_gb, memory_free_mb,
    messages_app_running, fda_status, clock_skew_ms,
    paused, revoked_at
) values (
    'dev_seed_revoked', _firm, _emp, _pub,
    'mac-revoked', 'Darwin 24.1.0', '0.0.1-dev',
    _now - interval '120 days', _now - interval '1 day', _now - interval '1 day',
    'offline', 0, 100, 4000,
    false, 'granted', 0,
    false, _now - interval '12 hours'
) on conflict (device_id) do update set
    revoked_at = excluded.revoked_at;

-- Sample pending_command rows so the device page has a non-empty
-- commands table. Attached to the "critical" device because that's
-- the one you'd naturally click first.
insert into pending_command (
    command_id, firm_id, device_id, action, issued_by,
    issued_at, delivered_at, completed_at, result, error, expires_at
) values
    -- a queued command: no delivered_at, user should see Cancel button
    (
        '00000000-0000-0000-0000-00000000a001',
        _firm, 'dev_seed_critical', 'diagnose', 'you@example.com',
        _now - interval '30 seconds', null, null, null, null,
        _now + interval '23 hours'
    ),
    -- a completed command with a result (what diagnose looks like)
    (
        '00000000-0000-0000-0000-00000000a002',
        _firm, 'dev_seed_silent', 'diagnose', 'you@example.com',
        _now - interval '10 minutes',
        _now - interval '9 minutes',
        _now - interval '9 minutes',
        jsonb_build_object(
            'chatdb_exists', true,
            'chatdb_mtime', extract(epoch from _now - interval '6 hours'),
            'messages_app_running', true,
            'queue_depth', 0,
            'last_rowid', 42731,
            'paused', false,
            'agent_version', '0.0.1-dev'
        ),
        null,
        _now + interval '23 hours'
    )
on conflict (command_id) do nothing;

-- Sample audit_log rows so /audit isn't empty
insert into audit_log (firm_id, actor_type, actor_id, action, target_type, target_id, metadata, occurred_at)
values
    (_firm, 'system', 'enroll', 'device_enrolled', 'device', 'dev_seed_healthy',
     jsonb_build_object('employee_email', 'you@example.com'), _now - interval '7 days'),
    (_firm, 'supervisor', 'you@example.com', 'page_view', 'page', '/devices',
     '{}'::jsonb, _now - interval '2 hours'),
    (_firm, 'supervisor', 'you@example.com', 'command_issued', 'device', 'dev_seed_silent',
     jsonb_build_object('command_action', 'diagnose'), _now - interval '10 minutes'),
    (_firm, 'supervisor', 'you@example.com', 'login', 'stepup', 'you@example.com',
     jsonb_build_object('result', 'granted'), _now - interval '5 minutes');

raise notice 'seeded % devices under %', 6, _firm;
end $$;
