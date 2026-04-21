import type { ReactNode } from 'react';
import { env } from '../lib/env';

export const metadata = {
  title: 'ArchiveGLP',
  description: 'SEC 17a-4 / FINRA 3110 electronic communications archive',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #ddd',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <strong>{env.NEXT_PUBLIC_APP_NAME}</strong>
          <span style={{ color: '#666' }}>
            {process.env.FIRM_ID ?? 'unbound-firm'}
          </span>
        </header>
        <main style={{ padding: 20 }}>{children}</main>
      </body>
    </html>
  );
}
