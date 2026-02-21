import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Honor the Chain — Imajin',
  description: 'The .fair protocol as attribution infrastructure. A cryptographically signed document embedded in the work itself, carrying the complete chain of human creative labor.',
  openGraph: {
    title: 'Honor the Chain',
    description: 'The .fair protocol — attribution as infrastructure.',
    url: 'https://imajin.ai/articles/honor-the-chain',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">Honor the Chain</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">The .fair protocol — attribution as infrastructure</p>

        <p>I was sitting in the WeR1 codebase in Johannesburg when my brain broke. They'd built a distribution algorithm that tracked every track in every mix and distributed revenue accordingly. It was working.</p>

        <p>And then I saw the gap. Distribution without attribution is a system built on a foundation you don't own.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The .fair Manifest</h2>

        <p>A cryptographically signed document embedded in the creative work itself — not in a platform database, not in a label's rights management system — carrying the complete chain of human creative labor that produced it.</p>

        <p>Who made it. Who contributed what. What prior work it derives from. What compensation executes automatically when those terms are triggered. The manifest travels with the work. Immutably. Owned by nobody. Verifiable by anyone.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What This Changes</h2>

        <p>The producer whose bass line became the sample. The journalist who cultivated a source for three years. The writer whose decade of thought trained a model. Their contribution is in the file. The terms are in the file.</p>

        <p>The chain is the culture. The culture survives only if the chain can be honored.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
