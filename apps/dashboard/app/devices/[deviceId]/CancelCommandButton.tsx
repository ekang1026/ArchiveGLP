'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  commandId: string;
  action: string;
}

export function CancelCommandButton({ commandId, action }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    if (!window.confirm(`Cancel queued ${action}?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/commands/${encodeURIComponent(commandId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{
          padding: '2px 8px',
          fontSize: 12,
          border: '1px solid #ccc',
          background: busy ? '#f3f3f3' : '#fff',
          borderRadius: 3,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Canceling…' : 'Cancel'}
      </button>
      {err && <span style={{ color: '#9a1c1c', fontSize: 12 }}>{err}</span>}
    </span>
  );
}
