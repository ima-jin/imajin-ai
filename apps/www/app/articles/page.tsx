import Link from 'next/link';
import type { Metadata } from 'next';
import { getAllArticles, type ArticleStatus } from '@/lib/articles';

export const metadata: Metadata = {
  title: 'Articles — Imajin',
  description: 'Thoughts on sovereignty, technology, and the future of the internet.',
};

function StatusBadge({ status }: { status: ArticleStatus }) {
  if (status === 'POSTED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-400">
        Published
      </span>
    );
  }
  if (status === 'REVIEW') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-500/20 text-orange-400">
        In Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-500/20 text-gray-400">
      Draft
    </span>
  );
}

export default function ArticlesPage() {
  const articles = getAllArticles();

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
          Twenty essays on sovereignty, technology, and the future of the internet.
        </p>

        <div className="space-y-6">
          {articles.map((article, index) => (
            <Link 
              key={article.slug}
              href={`/articles/${article.slug}`}
              className="block p-6 -mx-6 rounded-xl hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 font-mono">{String(index + 1).padStart(2, '0')}</span>
                  <h2 className="text-xl font-medium text-white group-hover:text-orange-400 transition-colors">{article.title}</h2>
                </div>
                <StatusBadge status={article.status} />
              </div>
              <p className="text-gray-400 ml-9">{article.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
