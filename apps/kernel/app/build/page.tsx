import type { Metadata } from 'next';
import Link from 'next/link';
import { getBuildEntries } from '@/src/lib/www/build-log';

export const metadata: Metadata = {
  title: 'Build Log — Imajin',
  description: 'What we shipped, when we shipped it. Building sovereign technology in public.',
};

export default async function BuildPage() {
  const entries = await getBuildEntries();

  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <div className="mb-12">
          <Link
            href="/"
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← Home
          </Link>
        </div>

        {/* Header */}
        <header className="mb-16">
          <h1 className="text-4xl font-bold text-white mb-4">Build Log</h1>
          <p className="text-lg text-gray-400">
            What we shipped, when we shipped it. Building sovereign technology in public.
          </p>
        </header>

        {/* Entries */}
        <div className="space-y-16">
          {entries.map((entry, i) => (
            <article key={i} className="relative">
              {/* Date & title */}
              <div className="mb-6">
                <time className="text-sm font-mono text-amber-500/80">
                  {entry.date}
                </time>
                {entry.title && (
                  <h2 className="text-2xl font-semibold text-white mt-1">
                    {entry.title}
                  </h2>
                )}
              </div>

              {/* Content */}
              <div
                className="prose prose-invert prose-sm max-w-none
                  prose-li:text-gray-300
                  prose-strong:text-white
                  prose-code:text-amber-400
                  prose-a:text-amber-500 prose-a:no-underline hover:prose-a:underline"
                dangerouslySetInnerHTML={{ __html: entry.contentHtml }}
              />

              {/* Divider (except last) */}
              {i < entries.length - 1 && (
                <div className="mt-16 border-t border-white/5" />
              )}
            </article>
          ))}
        </div>

        {/* Footer */}
        <footer className="mt-24 pt-8 border-t border-white/5 text-center">
          <p className="text-sm text-gray-500">
            🟠 Built with sovereignty in mind.
          </p>
        </footer>
      </div>
    </main>
  );
}
