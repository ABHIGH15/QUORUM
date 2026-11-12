import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quorum — Governed Group Purchasing',
  description: 'Governed group purchasing: AI proposes, members vote, PayPal pays',
  openGraph: {
    title: 'Quorum — Governed Group Purchasing',
    description: 'Governed group purchasing: AI proposes, members vote, PayPal pays',
    url: 'https://quorum-governance.onrender.com',
    siteName: 'Quorum',
    type: 'website',
  },
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
