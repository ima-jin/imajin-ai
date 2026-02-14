import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FixReady - Appliance Pre-Registration & Repair Intake',
  description: 'Prepare your appliances so repairs are faster when you need them.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
