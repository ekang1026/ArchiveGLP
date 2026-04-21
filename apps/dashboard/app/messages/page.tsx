import { requireSession } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const session = await requireSession();
  return (
    <div>
      <h2>Messages</h2>
      <p style={{ color: '#666' }}>
        Not yet wired to Supabase. See apps/dashboard/SUPABASE_SETUP.md for the
        "next slice" list. For now, inspect captured messages in the Supabase
        Table Editor → <code>message_meta</code>.
      </p>
      <p style={{ color: '#666', fontSize: 12 }}>Signed in as {session.email}.</p>
    </div>
  );
}
