import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveHandle, getArticlesByAuthor } from '@/src/lib/www/articles';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const author = await resolveHandle(handle);

  if (!author) {
    return { title: 'Author Not Found' };
  }

  const displayName = author.name || `@${author.handle}`;

  return {
    title: `Articles by ${displayName} — Imajin`,
    description: `Essays and articles by ${displayName} on the Imajin network.`,
  };
}

export default async function AuthorArticlesPage({ params }: Props) {
  const { handle } = await params;
  const author = await resolveHandle(handle);

  if (!author) {
    notFound();
  }

  const articles = await getArticlesByAuthor(author.did);
  const displayName = author.name || `@${author.handle}`;

  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <div className="mb-12">
          <Link
            href="/articles"
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← All Articles
          </Link>
        </div>

        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4">{displayName}</h1>
        <p className="text-xl text-gray-400 mb-12">
          {articles.length} article{articles.length !== 1 ? 's' : ''}
        </p>

        <div className="space-y-6">
          {articles.map((article, index) => (
            <Link
              key={article.slug}
              href={`/articles/${handle}/${article.slug}`}
              className="block p-6 -mx-6 rounded-xl hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 font-mono">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h2 className="text-xl font-medium text-white group-hover:text-orange-400 transition-colors">
                    {article.title}
                  </h2>
                </div>
                <span className="text-sm text-gray-600 whitespace-nowrap">
                  {article.date}
                </span>
              </div>
              <p className="text-gray-400 ml-9">{article.description}</p>
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
