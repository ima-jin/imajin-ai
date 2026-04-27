import Link from 'next/link';
import type { Metadata } from 'next';
import { getAllArticles, type ArticleStatus } from '@/src/lib/www/articles';

export const metadata: Metadata = {
  title: 'Articles — Imajin',
  description: 'Thoughts on sovereignty, technology, and the future of the internet.',
};

function StatusBadge({ status }: { status: ArticleStatus }) {
  if (status === 'POSTED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-success/20 text-success">
        Published
      </span>
    );
  }
  if (status === 'REVIEW') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-imajin-orange/20 text-imajin-orange">
        In Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-gray-500/20 text-secondary">
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
            className="text-secondary hover:text-primary transition-colors"
          >
            ← Home
          </Link>
        </div>

        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 font-mono">Articles</h1>
        <p className="text-xl text-secondary mb-12">
          Twenty essays on sovereignty, technology, and the future of the internet.
        </p>

        <div className="space-y-6">
          {articles.map((article, index) => (
            <Link
              key={article.slug}
              href={`/articles/${article.slug}`}
              className="block p-6 -mx-6 hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted font-mono">{String(index + 1).padStart(2, '0')}</span>
                  <h2 className="text-xl font-medium text-primary group-hover:text-imajin-orange transition-colors font-mono">{article.title}</h2>
                </div>
                <StatusBadge status={article.status} />
              </div>
              <p className="text-secondary ml-9">{article.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
