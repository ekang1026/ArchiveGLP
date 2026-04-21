-- Add `diagnose` to the remediation action enum.
--
-- Paired with the dashboard's "silent" device detection: when an
-- agent is heartbeating but hasn't captured any messages in hours,
-- a supervisor clicks Diagnose and the agent reports chat.db mtime,
-- Messages.app process status, queue depth, and other cheap checks
-- into the command's `result` JSON. No side-effects on the device.

alter table pending_command
    drop constraint if exists pending_command_action_check;

alter table pending_command
    add constraint pending_command_action_check
    check (action in (
        'resync',
        'pause',
        'resume',
        'rotate_key',
        'revoke',
        'upgrade',
        'restart_agent',
        'restart_machine',
        'diagnose'
    ));
