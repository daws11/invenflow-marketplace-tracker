import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'InvenFlow Marketplace Tracker',
  description:
    'Self-hosted sidecar that scrapes Tokopedia/Shopee buyer dashboards and syncs orders into InvenFlow.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
