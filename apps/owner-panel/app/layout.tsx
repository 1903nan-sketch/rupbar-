import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'RupBar — Painel', template: '%s · RupBar' },
  description: 'Painel online do proprietário — RupBar by Ruptix',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#0A84FF', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
