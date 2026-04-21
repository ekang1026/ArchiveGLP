-- ArchiveGLP schema for Supabase (Postgres).
--
-- Design posture note:
--   This schema is the "fun project" / fleet-management path. It uses
--   normal mutable Postgres. It is NOT SEC 17a-4 compliant because
--   Postgres has no WORM equivalent to S3 Object Lock Compliance.
--   The tier-2 compliance refactor re-introduces S3-backed archival
--   alongside this metadata DB; see infra/ for the CDK path.
--
-- How to apply:
--   Supabase dashboard -> SQL editor -> paste + run.
--   Or: supabase migration new archiveglp_schema && paste into the generated file.

--
-- Tables
--

create table if not exists firm (
    firm_id            text primary key,
    display_name       text not null,
    retention_years    smallint not null check (retention_years >= 1),
    legal_hold_default boolean not null default false,
    created_at         timestamptz not null default now()
);

create table if not exists employee (
    employee_id  text primary key,
    firm_id      text not null references firm(firm_id),
    email        text not null,
    full_name    text not null,
    enrolled_at  timestamptz,
    active       boolean not null default true
);
create index if not exists employee_firm_idx on employee (firm_id);

create table if not exists device (
    device_id            text primary key,
    firm_id              text not null references firm(firm_id),
    employee_id          text not null references employee(employee_id),
    public_key_spki_b64  text not null,
    os_version           text,
    agent_version        text,
    hostname             text,
    uptime_seconds       bigint,
    disk_free_gb         numeric,
    memory_free_mb       bigint,
    messages_app_running boolean,
    fda_status           text,
    enrolled_at          timestamptz not null,
    last_heartbeat_at    timestamptz,
    last_captured_at     timestamptz,
    status               text not null default 'healthy',
    queue_depth          integer not null default 0,
    clock_skew_ms        integer not null default 0,
    paused               boolean not null default false,
    revoked_at           timestamptz
);
create index if not exists device_employee_idx on device (employee_id);
create index if not exists device_firm_heartbeat_idx on device (firm_id, last_heartbeat_at);
create index if not exists device_firm_status_idx on device (firm_id, status);

-- Per-firm monotonic sequence for archive ordering.
create sequence if not exists archive_seq start 1;

-- RPC wrapper the ingest Route Handler calls. Returns a single
-- nextval'd archive sequence number per call. Exposed via PostgREST
-- at POST /rpc/next_archive_seq.
create or replace function next_archive_seq()
returns bigint
language sql
volatile
security definer
as $$
  select nextval('archive_seq')
$$;
grant execute on function next_archive_seq() to service_role;
grant execute on function next_archive_seq() to authenticated;

create table if not exists message_meta (
    archive_seq       bigint primary key,
    message_id        text not null,
    firm_id           text not null references firm(firm_id),
    employee_id       text not null references employee(employee_id),
    device_id         text not null references device(device_id),
    source            text not null,
    conversation_id   text not null,
    direction         text not null,
    from_handle       text not null,
    to_handles        text[] not null,
    body_text         text not null default '',
    unsent            boolean not null default false,
    captured_at       timestamptz not null,
    ingested_at       timestamptz not null,
    archived_at       timestamptz not null default now(),
    payload_sha256    text not null,
    raw_source        jsonb,
    body_text_tsv     tsvector generated always as (to_tsvector('english', body_text)) stored,
    unique (firm_id, message_id)
);
create index if not exists message_firm_captured_idx on message_meta (firm_id, captured_at desc);
create index if not exists message_firm_employee_captured_idx on message_meta (firm_id, employee_id, captured_at desc);
create index if not exists message_firm_conversation_idx on message_meta (firm_id, conversation_id, captured_at desc);
create index if not exists message_tsv_idx on message_meta using gin (body_text_tsv);

create table if not exists attachment_meta (
    archive_seq  bigint not null references message_meta(archive_seq) on delete cascade,
    idx          smallint not null,
    sha256       text not null,
    mime         text not null,
    bytes        bigint not null,
    storage_key  text,
    primary key (archive_seq, idx)
);

-- Supervisor actions + system events.
create table if not exists audit_log (
    audit_seq    bigserial primary key,
    firm_id      text not null references firm(firm_id),
    actor_type   text not null check (actor_type in ('supervisor', 'd3p', 'system')),
    actor_id     text not null,
    action       text not null,
    target_type  text,
    target_id    text,
    metadata     jsonb,
    occurred_at  timestamptz not null default now()
);
create index if not exists audit_firm_occurred_idx on audit_log (firm_id, occurred_at desc);
create index if not exists audit_firm_actor_idx on audit_log (firm_id, actor_id, occurred_at desc);

-- Single-use pairing codes for device enrollment. Admin creates; agent consumes.
create table if not exists pending_enrollment (
    pairing_code        text primary key,
    firm_id             text not null references firm(firm_id),
    employee_id         text not null,
    employee_email      text not null,
    employee_full_name  text not null,
    created_at          timestamptz not null default now(),
    expires_at          timestamptz not null,
    used_at             timestamptz,
    used_by_device_id   text
);
create index if not exists pending_enrollment_firm_employee_idx
    on pending_enrollment (firm_id, employee_id);
create index if not exists pending_enrollment_unused_expiry_idx
    on pending_enrollment (expires_at) where used_at is null;

-- Control-plane commands sent from the dashboard to specific devices.
-- The agent polls /v1/commands each heartbeat. Commands are executed
-- once; the agent acks by updating completed_at and result.
create table if not exists pending_command (
    command_id    uuid primary key default gen_random_uuid(),
    firm_id       text not null references firm(firm_id),
    device_id     text not null references device(device_id),
    action        text not null check (action in ('resync', 'pause', 'resume', 'rotate_key', 'revoke', 'upgrade')),
    parameters    jsonb,
    issued_by     text not null,
    issued_at     timestamptz not null default now(),
    delivered_at  timestamptz,
    completed_at  timestamptz,
    result        jsonb,
    error         text
);
create index if not exists pending_command_device_open_idx
    on pending_command (device_id, issued_at) where completed_at is null;

--
-- Row-level security
--
-- Enable RLS on everything. The service-role key (used by our Next.js
-- Route Handlers) bypasses RLS by design, so the agent-facing routes
-- continue to work. Dashboard queries use the anon key with an
-- authenticated user session; the policies below define what
-- signed-in users are allowed to see. For a single-firm personal
-- project, "authenticated user can read/write everything" is fine.
-- Multi-tenant later: match on a custom firm_id claim in the JWT.
--

alter table firm               enable row level security;
alter table employee           enable row level security;
alter table device             enable row level security;
alter table message_meta       enable row level security;
alter table attachment_meta    enable row level security;
alter table audit_log          enable row level security;
alter table pending_enrollment enable row level security;
alter table pending_command    enable row level security;

-- Default "authenticated user can do everything." Replace with firm-
-- scoped policies when multi-tenant.
do $$
declare
    t text;
begin
    for t in
        select tablename from pg_tables
        where schemaname = 'public'
          and tablename in (
            'firm','employee','device','message_meta','attachment_meta',
            'audit_log','pending_enrollment','pending_command'
          )
    loop
        execute format(
            'drop policy if exists authenticated_rw on %I;', t
        );
        execute format($p$
            create policy authenticated_rw on %I
            for all to authenticated
            using (true) with check (true);
        $p$, t);
    end loop;
end $$;
