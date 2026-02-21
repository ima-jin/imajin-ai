import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Business Case for Building on Human Trust — Imajin',
  description: 'The numbers for operators and builders. Three industries — advertising, music, journalism — representing ~$800B in annual revenue.',
  openGraph: {
    title: 'The Business Case for Building on Human Trust',
    description: 'Three industries representing ~$800B in annual revenue, almost none reaching the humans who create the value.',
    url: 'https://imajin.ai/articles/the-business-case',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Business Case for Building on Human Trust</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">What the numbers actually mean — for the people doing the building</p>

        <p>Three industries are broken in the same way. Advertising. Music. Journalism. Combined they represent roughly <strong>$800 billion in annual revenue</strong> — almost none of it reaching the humans who create the value.</p>

        <hr className="my-12 border-gray-800" />

        <h2>Why Subscriptions Are Extractive</h2>

        <p>The subscription model was not designed for creators. It was designed for platforms. We destroy it completely.</p>

        <p>You deposit credit into your account. That credit only moves when you consume human creativity. Every transaction is visible. Every cent is traceable. And every payment goes directly to the human whose work you just consumed.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Three Types</h2>

        <p><strong>The Creator</strong> — their catalogue earns. Thirty years of work is worth more than their latest release.</p>
        <p><strong>The Consumer</strong> — they can see where their attention goes. Eight cents to read this article, visible landing on the journalist's node.</p>
        <p><strong>The Creator/Consumer</strong> — curation earns. The friend who always knows the right article finally gets compensated.</p>

        <hr className="my-12 border-gray-800" />

        <p>Come build on rails that can't be owned.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
