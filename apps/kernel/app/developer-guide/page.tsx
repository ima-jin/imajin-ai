import Link from 'next/link';
import type { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';

export const metadata: Metadata = {
  title: 'Developer Guide — Imajin',
  description:
    'Build on the Imajin network. APIs, curl examples, identity, attribution, and payments — everything you need to get started.',
  openGraph: {
    title: 'MJN Developer Guide',
    description:
      'The practical companion to the MJN whitepaper. APIs, curl examples, 5-minute walkthrough.',
    url: 'https://imajin.ai/developer-guide',
    type: 'article',
  },
};

async function getGuideHtml(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), 'docs', 'developer-guide.md'),
    path.join(process.cwd(), '..', '..', 'docs', 'developer-guide.md'),
    path.join(process.cwd(), 'apps', 'www', '..', '..', 'docs', 'developer-guide.md'),
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
    return '<p>Developer guide not found.</p>';
  }

  // Remove the title line (we render it separately)
  content = content.replace(/^#\s+MJN Developer Guide\n/, '');

  const result = await remark().use(remarkGfm).use(html, { sanitize: false }).process(content);
  return result.toString();
}

export default async function DeveloperGuidePage() {
  const contentHtml = await getGuideHtml();

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
          Developer Guide
        </h1>
        <p className="text-xl text-gray-400 mb-12 !mt-0">
          What you need to know to build on the Imajin network.
        </p>

        <div dangerouslySetInnerHTML={{ __html: contentHtml }} />

        <div className="mt-16 pt-8 border-t border-gray-800 not-prose">
          <div className="flex flex-col sm:flex-row gap-4">
            <Link
              href="/whitepaper"
              className="inline-block px-8 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors text-center"
            >
              Read the Whitepaper
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
