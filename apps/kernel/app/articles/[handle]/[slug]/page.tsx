import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveHandle, getAllArticleSlugs, getArticleBySlug } from '@/src/lib/www/articles';
import { ImajinFooter } from '@imajin/ui';

// Articles now load from the database (media.assets), so static generation
// requires a DB connection at build time. Force dynamic rendering instead.
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ handle: string; slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, slug } = await params;
  const author = await resolveHandle(handle);
  if (!author) return { title: 'Article Not Found' };

  const article = await getArticleBySlug(author.did, slug);

  if (!article) {
    return { title: 'Article Not Found' };
  }

  return {
    title: article.title,
    description: article.description,
    openGraph: {
      title: article.title,
      description: article.description,
      url: `https://imajin.ai/articles/${handle}/${slug}`,
      type: 'article',
      publishedTime: article.date,
      authors: [article.author],
    },
    twitter: {
      card: 'summary',
      title: article.title,
      description: article.description,
    },
  };
}

export default async function ArticlePage({ params }: Props) {
  const { handle, slug } = await params;
  const author = await resolveHandle(handle);
  if (!author) notFound();

  const article = await getArticleBySlug(author.did, slug);

  if (!article) {
    notFound();
  }

  return (
    <main className="min-h-screen py-16 px-6">
      {/* Back link */}
      <div className="max-w-3xl mx-auto mb-12">
        <Link
          href={`/articles/${handle}`}
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← {author.name || `@${handle}`}
        </Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">
          {article.title}
        </h1>
        {article.subtitle && (
          <p className="text-xl text-gray-400 mb-12 !mt-0">
            {article.subtitle}
          </p>
        )}

        <div
          dangerouslySetInnerHTML={{ __html: article.contentHtml }}
        />

        {/* Footer */}
        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <ImajinFooter />
        </div>
      </article>
    </main>
  );
}
