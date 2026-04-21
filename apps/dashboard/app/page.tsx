export default function HomePage() {
  return (
    <div>
      <h1>Supervisor dashboard</h1>
      <p>Sign in to search and review archived communications.</p>
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
        Every search, view, and export on this dashboard is recorded to the archive under SEC
        17a-4(b)(4).
      </p>
    </div>
  );
}
