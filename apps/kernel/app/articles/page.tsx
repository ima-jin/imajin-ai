import Link from 'next/link';
import type { Metadata } from 'next';
import { getAllArticles } from '@/src/lib/www/articles';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Articles — Imajin',
  description: 'Thoughts on sovereignty, technology, and the future of the internet.',
};

export default async function ArticlesPage() {
  const articles = await getAllArticles();

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
          Essays on sovereignty, technology, and the future of the internet.
        </p>

        <div className="space-y-6">
          {articles.map((article) => (
            <Link
              key={`${article.authorHandle}/${article.slug}`}
              href={`/articles/${article.authorHandle}/${article.slug}`}
              className="block p-6 -mx-6 rounded-xl hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <h2 className="text-xl font-medium text-white group-hover:text-orange-400 transition-colors">
                  {article.title}
                </h2>
                <span className="text-sm text-gray-600 whitespace-nowrap">
                  {article.date}
                </span>
              </div>
              <p className="text-gray-400">{article.description}</p>
              {article.authorHandle && (
                <p className="text-sm text-gray-600 mt-2">@{article.authorHandle}</p>
              )}
            </Link>
          ))}

          {articles.length === 0 && (
            <p className="text-gray-500">No articles yet.</p>
          )}
        </div>
      </div>
    </main>
  );
}
