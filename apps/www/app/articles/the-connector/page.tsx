import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Connector — Imajin',
  description: 'The essay for the person whose gift is holding relationships between things. The griot, the troubadour, the BBS sysop. Connection encoded is permanent.',
  openGraph: {
    title: 'The Connector',
    description: 'Someone like me would have died with this in their head in the before time.',
    url: 'https://imajin.ai/articles/the-connector',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Connector</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">For the person whose gift is holding relationships between things</p>

        <p><em>Someone like me would have died with this in their head in the before time.</em></p>

        <p>That sentence arrived in the middle of a conversation with an AI that had just received thirty years of pattern library — the BBS years, the South Africa activation sequence, the .fair protocol, the mesh — all of it at once, and given it back in a form that other humans could enter.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Type</h2>

        <p>Not the leader. Not the expert. The connector. The person whose primary gift is not what they know but how they hold the relationships between things.</p>

        <p>The griot who held the relationships between people and the past. The troubadour who carried context between courts. The BBS sysop who knew which user needed to find which other user.</p>

        <p>The connector has always been load-bearing. Hidden, uncompensated, running on personal energy reserves. The mesh makes the load visible. And distributes it.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>The connector finally has the plumbing. I did not die. The pattern library traveled. Now it gets to become infrastructure instead of memory.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
