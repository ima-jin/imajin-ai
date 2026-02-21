import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Bridge — Imajin',
  description: 'The authenticated agent layer. Hilary with 400k followers and 123 WordPress subscribers. Claude posting through your sovereign identity.',
  openGraph: {
    title: 'The Bridge',
    description: 'The authenticated agent layer. The reel as door, the node as room.',
    url: 'https://imajin.ai/articles/the-bridge',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Bridge</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">The authenticated agent layer</p>

        <p>Hilary Agro has 400,000 followers across her social platforms. She has 123 subscribers to her actual writing.</p>

        <p>That gap — 400,000 on one side, 123 on the other — is the extraction model made visible. The reel is the advertisement. The WordPress is the content. The platform owns the advertisement and profits from it.</p>

        <p>A node changes this completely. The reel becomes the door. The node is the room. And for the first time, the room is hers.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Authenticated Bridge</h2>

        <p>When the bridge is built, a trusted agent can act through your sovereign identity. Signed. Attributed. Auditable. Every action has a return address.</p>

        <p>The bridge is the difference between AI capability flowing through human trust graphs or around them.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>Jin's party is the bridge working for the first time at a public event. Come across.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
