-- At-least-once command delivery.
--
-- Previously GET /v1/commands filtered `delivered_at IS NULL`, which
-- stranded commands whenever the HTTP response to the agent was lost
-- after the server stamped delivered_at. The server had already
-- "delivered" the command but the agent never saw it, and it sat
-- forever with completed_at IS NULL.
--
-- Fix posture: re-deliver any command that is not yet completed and
-- whose last delivery attempt was longer than a timeout window ago.
-- The agent is responsible for suppressing duplicate execution by
-- command_id (it keeps an executed-command log locally).

alter table pending_command
    add column if not exists delivery_attempts  integer     not null default 0,
    add column if not exists last_delivered_at  timestamptz;

-- Backfill: any command with delivered_at set has been attempted once
-- under the old semantics. Treat delivered_at as the last attempt too.
update pending_command
set last_delivered_at = delivered_at,
    delivery_attempts = case when delivered_at is null then 0 else 1 end
where last_delivered_at is null;

-- Supports the GET poll: "open commands ready for (re)delivery".
create index if not exists pending_command_device_redeliver_idx
    on pending_command (device_id, last_delivered_at)
    where completed_at is null;
