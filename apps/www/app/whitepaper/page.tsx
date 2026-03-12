import Link from 'next/link';
import type { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import { remark } from 'remark';
import html from 'remark-html';

export const metadata: Metadata = {
  title: 'MJN Protocol Whitepaper — Imajin',
  description:
    'The iMaJiN Network Protocol. Identity · Attribution · Settlement · Presence. An open application-layer protocol that carries the human.',
  openGraph: {
    title: 'MJN Protocol Whitepaper',
    description:
      'Identity · Attribution · Settlement · Presence. The protocol the internet never had.',
    url: 'https://imajin.ai/whitepaper',
    type: 'article',
  },
};

async function getWhitepaperHtml(): Promise<string> {
  // docs/ lives at monorepo root — handle both build-time and runtime cwd
  const candidates = [
    path.join(process.cwd(), 'docs', 'mjn-whitepaper.md'),
    path.join(process.cwd(), '..', '..', 'docs', 'mjn-whitepaper.md'),
    path.join(process.cwd(), 'apps', 'www', '..', '..', 'docs', 'mjn-whitepaper.md'),
  ];

  let content = '';
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        content = fs.readFileSync(candidate, 'utf8');
        break;
      }
    } catch {
      continue;
    }
  }

  if (!content) {
    return '<p>Whitepaper not found.</p>';
  }

  // Remove the title line (we render it separately)
  content = content.replace(/^#\s+MJN\n/, '');

  const result = await remark().use(html, { sanitize: false }).process(content);
  return result.toString();
}

export default async function WhitepaperPage() {
  const contentHtml = await getWhitepaperHtml();

  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto mb-12">
        <Link
          href="/"
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Home
        </Link>
      </div>

      <article className="max-w-3xl mx-auto prose prose-invert prose-lg prose-orange">
        <h1 className="text-4xl md:text-5xl font-light tracking-tight mb-4 !text-white">
          MJN Protocol
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          The iMaJiN Network Protocol — Identity · Attribution · Settlement · Presence
        </p>

        <div dangerouslySetInnerHTML={{ __html: contentHtml }} />

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <div className="flex flex-col sm:flex-row gap-4">
            <Link
              href="/articles"
              className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors text-center"
            >
              Read the Essays
            </Link>
            <a
              href="https://github.com/ima-jin/imajin-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-8 py-3 border border-gray-700 hover:border-gray-500 text-gray-300 font-medium rounded-lg transition-colors text-center"
            >
              View Source
            </a>
          </div>
        </div>
      </article>
    </main>
  );
}
