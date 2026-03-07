import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Apps — Imajin',
  description: 'Explore the Imajin app ecosystem.',
};

export default function AppsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
