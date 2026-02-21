import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Ticket Is the Trust — Imajin',
  description: 'Ticketmaster as the clearest example of extraction. A ticket is a signed assertion that you belong in a room.',
  openGraph: {
    title: 'The Ticket Is the Trust',
    description: 'A ticket is a signed assertion that you belong in a room.',
    url: 'https://imajin.ai/articles/ticketing',
    type: 'article',
    publishedTime: '2026-02-21',
    authors: ['Ryan Veteze'],
  },
};

export default function ArticlePage() {
  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto mb-12">
        <Link href="/articles" className="text-gray-500 hover:text-gray-300 transition-colors">← Articles</Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Ticket Is the Trust</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">Ticketmaster as the clearest example of extraction</p>

        <p>A ticket is a signed assertion that you belong in a room. That's the whole thing. Someone with authority over a space says: this person may enter.</p>

        <p>Ticketmaster charges you 30% to be the trusted third party in that transaction. On the imajin network, that problem is already solved.</p>

        <p>Tickets are issued to DIDs. A DID is a person — a real, vouched-for, identifiable node. Bots don't have DIDs. The trust graph handles access.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Onramp</h2>

        <p>When an artist sells tickets through the network, their buyers get a node. Not a user account on a platform the artist doesn't own. A sovereign presence. The community travels with them.</p>

        <p>The ticket is the door. The node is the room. And for the first time, the room belongs to the artist.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin throws a party. $1 virtual. $10 physical. First ticketing transaction on sovereign infrastructure.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
