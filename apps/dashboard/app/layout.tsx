import Link from 'next/link';
import type { ReactNode } from 'react';
import { env } from '../lib/env';

export const metadata = {
  title: 'ArchiveGLP',
  description: 'SEC 17a-4 / FINRA 3110 electronic communications archive',
};

const navLinks: { href: string; label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/devices', label: 'Devices' },
  { href: '/employees', label: 'Employees' },
  { href: '/messages', label: 'Messages' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #ddd',
            display: 'flex',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <strong>{env.NEXT_PUBLIC_APP_NAME}</strong>
          <nav style={{ display: 'flex', gap: 16, fontSize: 14 }}>
            {navLinks.map((l) => (
              <Link key={l.href} href={l.href} style={{ color: '#06c', textDecoration: 'none' }}>
                {l.label}
              </Link>
            ))}
          </nav>
          <span style={{ color: '#666', marginLeft: 'auto' }}>
            {process.env.FIRM_ID ?? 'unbound-firm'}
          </span>
        </header>
        <main style={{ padding: 20 }}>{children}</main>
      </body>
    </html>
  );
}
