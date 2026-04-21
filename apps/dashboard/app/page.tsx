import { recordAudit } from '../lib/audit';
import { requireSession } from '../lib/auth';

export default async function HomePage() {
  const session = await requireSession();
  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'page_view',
    targetType: 'page',
    targetId: '/',
  });

  return (
    <div>
      <h1>Supervisor dashboard</h1>
      <p>Signed in as {session.email}.</p>
      <ul>
        <li>
          <a href="/messages">Messages</a>
        </li>
        <li>
          <a href="/devices">Device health</a>
        </li>
        <li>
          <a href="/audit">Audit log</a>
        </li>
      </ul>
      <p style={{ color: '#666', fontSize: 12 }}>
        Every search, view, and export on this dashboard is recorded to the firm's audit log
        under SEC 17a-4(b)(4).
      </p>
    </div>
  );
}
