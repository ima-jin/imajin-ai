import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'I Need Help — Imajin',
  description: 'The thing founders aren\'t supposed to say. Twenty essays of proof laid down, then the honest ask: financial backing, dev help, other brains, community.',
  openGraph: {
    title: 'I Need Help',
    description: 'Twenty essays of proof laid down, then the honest ask.',
    url: 'https://imajin.ai/articles/i-need-help',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">I Need Help</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">The thing founders aren't supposed to say</p>

        <p>I have spent nineteen essays proving I know what I'm talking about.</p>

        <p>Now I need to say the thing founders aren't supposed to say.</p>

        <p>I need help.</p>

        <p>Not as a rhetorical flourish. Not as a humble-brag. I mean it literally. The weight of holding this whole framework in my head, alone, for months, is crushing me. I am the bottleneck I've been writing about.</p>

        <hr className="my-12 border-gray-800" />

        <h2>What I Actually Need</h2>

        <p><strong>Financial help.</strong> Not venture capital with control strings attached. Runway to get Jin's party running and the first real operator nodes live.</p>

        <p><strong>Dev help.</strong> People who read The Utility and felt something click. The federation protocol, the DID implementation, the payment rail integration.</p>

        <p><strong>Other brains.</strong> Economists. Cryptographers. Protocol designers. Community builders.</p>

        <p><strong>Community.</strong> People who read these essays and recognized something. People who want to be early in something trying to fix the architecture.</p>

        <hr className="my-12 border-gray-800" />

        <p>I am Ryan VETEZE, known as b0b. I have been building connective infrastructure since 1988. I ran b0bby's World. I have thirty years of pattern library and finally the tools to prove it.</p>

        <p>And I can't do it alone.</p>

        <p>If you've read all of this — you have enough context to know whether you belong in this.</p>

        <p><strong>Come in.</strong></p>

        <hr className="my-12 border-gray-800" />

        <p><strong>If you want to follow along:</strong></p>
        <ul>
          <li>The code: <a href="https://github.com/ima-jin/imajin-ai" target="_blank" rel="noopener noreferrer">github.com/ima-jin/imajin-ai</a></li>
          <li>The network: <a href="https://imajin.ai">imajin.ai</a></li>
          <li>Jin's party: April 1st, 2026</li>
        </ul>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
