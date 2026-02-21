import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Articles — Imajin',
  description: 'Thoughts on sovereignty, technology, and the future of the internet.',
};

const articles = [
  {
    slug: 'you-dont-need-ads',
    title: 'You Don\'t Need Ads. You Need a Better Business Model.',
    description: 'An open letter to Sam, Dario, Sundar, and Elon on why trust graphs beat ad models.',
    date: 'February 20, 2026',
  },
  {
    slug: 'the-trust-graph',
    title: 'The Internet That Pays You Back',
    description: 'Trust graphs, sovereign presence, and the architecture of connection.',
    date: 'February 19, 2026',
  },
  {
    slug: 'the-artificial-developer',
    title: 'I\'ve Been an AI Since 1988',
    description: 'Pattern recognition, iteration, and the tools that finally matched my brain.',
    date: 'February 18, 2026',
  },
  {
    slug: 'the-internet-we-lost',
    title: 'The Pain of Knowing',
    description: 'Why I\'m still fighting for the internet we lost. Three nodes. 300 users. Marriages. Lifelong friendships.',
    date: 'February 16, 2026',
  },
];

export default function ArticlesPage() {
  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <div className="mb-12">
          <Link 
            href="/" 
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← Home
          </Link>
        </div>

        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4">Articles</h1>
        <p className="text-xl text-gray-400 mb-12">
          Thoughts on sovereignty, technology, and the future of the internet.
        </p>

        <div className="space-y-8">
          {articles.map((article) => (
            <Link 
              key={article.slug}
              href={`/articles/${article.slug}`}
              className="block p-6 -mx-6 rounded-xl hover:bg-white/5 transition-colors"
            >
              <p className="text-sm text-gray-500 mb-2">{article.date}</p>
              <h2 className="text-2xl font-medium mb-2 text-white">{article.title}</h2>
              <p className="text-gray-400">{article.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
