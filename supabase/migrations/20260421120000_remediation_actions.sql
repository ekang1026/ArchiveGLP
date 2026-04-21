-- Add remote-remediation actions: restart_agent (fully hands-free,
-- re-execs the agent via launchctl kickstart) and restart_machine
-- (agent invokes osascript to reboot; user must log in again post-boot).
--
-- Old constraint name follows Postgres default for inline checks:
-- pending_command_action_check.

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
        'restart_machine'
    ));
