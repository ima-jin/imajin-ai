import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Imajin — Pitch Deck',
  description: 'What if every transaction you made built your reputation? Sovereign infrastructure for identity, payments, attribution, reputation, and trust.',
  robots: { index: false, follow: false },
};

export default function DeckLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="deck-layout">
      {children}
    </div>
  );
}
