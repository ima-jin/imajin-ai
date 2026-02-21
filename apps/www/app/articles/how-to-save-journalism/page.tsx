import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Press Isn\'t Free. It\'s Owned. — Imajin',
  description: 'Open letter to journalists still fighting, billionaires who broke it, and communities who never got it. What a sovereign press node looks like.',
  openGraph: {
    title: 'The Press Isn\'t Free. It\'s Owned.',
    description: 'What a sovereign press node looks like.',
    url: 'https://imajin.ai/articles/how-to-save-journalism',
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
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">The Press Isn't Free. It's Owned.</h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">An open letter to journalists still fighting, billionaires who broke it, and communities who never got it</p>

        <p>I live in Canada. As of this writing — nearly three years after it happened — I cannot see Canadian news in my Facebook feed. Because Mark Zuckerberg decided it was cheaper to disappear Canadian journalism than to pay a fraction of his revenue to news organizations.</p>

        <p>A foreign billionaire unilaterally restructured the information diet of an entire country. The Canadian government watched it happen and has done essentially nothing.</p>

        <hr className="my-12 border-gray-800" />

        <h2>The Mesh</h2>

        <p>A functioning journalism ecosystem is a mesh. Not a hierarchy. A network of reporters with local knowledge and trusted relationships whose work connects to adjacent work. The platforms killed this by replacing it with an engagement algorithm.</p>

        <p>The beat reporter's twenty years of city hall relationships is a trust graph. A sovereign node for a journalist is their knowledge made queryable by the community that depends on it.</p>

        <hr className="my-12 border-gray-800" />

        <h2>April 1st, 2026</h2>
        <p>The first small proof that information can travel through human trust rather than through platforms owned by billionaires. Come build it with us.</p>

        <p className="text-gray-500">— Ryan VETEZE, Founder, imajin.ai</p>

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <Link href="/register" className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors">Get Updates</Link>
        </div>
      </article>
    </main>
  );
}
