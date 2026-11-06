import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quorum — Autonomous AI Group Purchasing & Governance',
  description: 'Deterministic multi-agent governance & financial execution engine on PayPal.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
