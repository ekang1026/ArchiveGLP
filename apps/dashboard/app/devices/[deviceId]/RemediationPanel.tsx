'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Action =
  | 'diagnose'
  | 'resync'
  | 'pause'
  | 'resume'
  | 'restart_agent'
  | 'restart_machine'
  | 'revoke';

interface Props {
  deviceId: string;
  paused: boolean;
  revoked: boolean;
}

interface ActionSpec {
  action: Action;
  label: string;
  description: string;
  destructive: boolean;
  // Some actions need a typed confirmation (type the deviceId or a
  // sentinel) so a misclick can't reboot a machine or de-enroll.
  typedConfirmation?: string;
  visible: (p: Props) => boolean;
}

const SPECS: ActionSpec[] = [
  {
    action: 'diagnose',
    label: 'Diagnose',
    description:
      'Ask the agent to report chat.db mtime, Messages.app process status, queue depth, and FDA status. Read-only — no side effects. Use when the device is "silent" but heartbeating.',
    destructive: false,
    visible: (p) => !p.revoked,
  },
  {
    action: 'resync',
    label: 'Resync from start',
    description: 'Reset capture checkpoint. Agent re-reads chat.db from the beginning.',
    destructive: false,
    visible: (p) => !p.revoked,
  },
  {
    action: 'pause',
    label: 'Pause capture',
    description: 'Stop enqueueing new messages. Heartbeats continue.',
    destructive: false,
    visible: (p) => !p.revoked && !p.paused,
  },
  {
    action: 'resume',
    label: 'Resume capture',
    description: 'Clear pause; agent resumes enqueueing messages.',
    destructive: false,
    visible: (p) => !p.revoked && p.paused,
  },
  {
    action: 'restart_agent',
    label: 'Restart agent',
    description: 'Re-exec the agent process in place. No employee action required.',
    destructive: false,
    visible: (p) => !p.revoked,
  },
  {
    action: 'restart_machine',
    label: 'Restart machine',
    description:
      'Reboot macOS. User must log back in at the loginwindow after reboot (use Screen Sharing over Tailscale).',
    destructive: true,
    // Confirmation text is the device_id itself; handled inline in onClick.
    visible: (p) => !p.revoked,
  },
  {
    action: 'revoke',
    label: 'Revoke device',
    description:
      'Wipe the agent keypair and state on this device. Device must re-enroll with a new pairing code.',
    destructive: true,
    typedConfirmation: 'REVOKE',
    visible: () => true,
  },
];

export function RemediationPanel(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Prompts for the step-up password and exchanges it for a
  // short-lived cookie on /api/admin/step-up. Returns true on
  // success. Called before destructive commands so a stolen
  // supervisor cookie alone can't fire a revoke/reboot.
  async function stepUp(label: string): Promise<boolean> {
    const pw = window.prompt(
      `Re-enter supervisor password to authorize "${label}":`,
    );
    if (pw === null || pw === '') return false;
    const res = await fetch('/api/admin/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => ({}));
    setMessage({
      kind: 'err',
      text: `Step-up failed: ${body?.error ?? `HTTP ${res.status}`}`,
    });
    return false;
  }

  async function postCommand(action: Action, destructive: boolean): Promise<Response> {
    return fetch('/api/admin/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_id: props.deviceId,
        action,
        confirm: destructive ? true : undefined,
      }),
    });
  }

  async function issue(action: Action) {
    setBusy(action);
    setMessage(null);
    try {
      const spec = SPECS.find((s) => s.action === action);
      const destructive = Boolean(spec?.destructive);

      if (destructive) {
        const granted = await stepUp(spec?.label ?? action);
        if (!granted) return;
      }

      let res = await postCommand(action, destructive);
      // Expired stepup cookie between prompt and POST: re-prompt once.
      if (res.status === 401 && destructive) {
        const body = await res.clone().json().catch(() => ({}));
        if (body?.error === 'step_up_required') {
          const granted = await stepUp(spec?.label ?? action);
          if (!granted) return;
          res = await postCommand(action, destructive);
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errText = body?.error
          ? `${body.error}${body.action ? ` (${body.action})` : ''}`
          : `HTTP ${res.status}`;
        setMessage({ kind: 'err', text: `Failed: ${errText}` });
        return;
      }
      const body = await res.json();
      setMessage({
        kind: 'ok',
        text: `Command queued (${action}). The agent will pick it up on its next poll.`,
      });
      // Refresh the server-rendered page so the new row appears in
      // the commands table below.
      router.refresh();
      void body;
    } catch (e) {
      setMessage({
        kind: 'err',
        text: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
    }
  }

  function onClick(spec: ActionSpec) {
    if (spec.destructive) {
      if (spec.action === 'restart_machine') {
        const confirmText = window.prompt(
          `Type the device id to confirm machine restart:\n\n  ${props.deviceId}`,
        );
        if (confirmText !== props.deviceId) {
          setMessage({ kind: 'err', text: 'Confirmation did not match. Aborted.' });
          return;
        }
      } else if (spec.typedConfirmation) {
        const confirmText = window.prompt(
          `Type ${spec.typedConfirmation} to confirm ${spec.label.toLowerCase()}:`,
        );
        if (confirmText !== spec.typedConfirmation) {
          setMessage({ kind: 'err', text: 'Confirmation did not match. Aborted.' });
          return;
        }
      } else if (!window.confirm(`${spec.label}?\n\n${spec.description}`)) {
        return;
      }
    }
    void issue(spec.action);
  }

  const visible = SPECS.filter((s) => s.visible(props));

  return (
    <section style={{ marginTop: 24 }}>
      <h3 style={{ margin: '0 0 8px 0' }}>Remediation</h3>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Every action is recorded in the audit log.
      </p>
      {message && (
        <output
          style={{
            display: 'block',
            padding: '8px 12px',
            margin: '0 0 12px 0',
            background: message.kind === 'ok' ? '#e7f6ec' : '#fde8e8',
            color: message.kind === 'ok' ? '#15612a' : '#9a1c1c',
            border: `1px solid ${message.kind === 'ok' ? '#b3dec0' : '#f4b8b8'}`,
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {message.text}
        </output>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
        {visible.map((spec) => (
          <button
            key={spec.action}
            type="button"
            onClick={() => onClick(spec)}
            disabled={busy !== null}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              border: `1px solid ${spec.destructive ? '#f4b8b8' : '#ccc'}`,
              background: busy === spec.action ? '#f3f3f3' : spec.destructive ? '#fff6f6' : '#fff',
              cursor: busy !== null ? 'wait' : 'pointer',
              borderRadius: 4,
              font: 'inherit',
            }}
          >
            <div
              style={{
                fontWeight: 600,
                color: spec.destructive ? '#9a1c1c' : '#222',
              }}
            >
              {busy === spec.action ? `${spec.label}…` : spec.label}
            </div>
            <div style={{ color: '#555', fontSize: 12, marginTop: 4 }}>{spec.description}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
