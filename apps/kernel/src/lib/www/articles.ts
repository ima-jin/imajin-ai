import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';

// Articles directory - lives in docs/articles at the monorepo root.
// At build time, cwd may be monorepo root or apps/kernel. Handle both.
const articlesDirectory = fs.existsSync(path.join(process.cwd(), 'docs/articles'))
  ? path.join(process.cwd(), 'docs/articles')
  : path.join(process.cwd(), '../../docs/articles');

export type ArticleStatus = 'POSTED' | 'REVIEW' | 'DRAFT';

export interface ArticleMeta {
  slug: string;
  title: string;
  subtitle?: string;
  description: string;
  date: string;
  author: string;
  status: ArticleStatus;
  order: number;
}

export interface Article extends ArticleMeta {
  content: string;
  contentHtml: string;
}

// Map essay numbers to URL slugs
const slugMap: Record<string, string> = {
  'essay-00-prologue': 'prologue',
  'essay-01-the-internet-we-lost': 'the-internet-we-lost',
  'essay-02-the-artificial-developer': 'the-artificial-developer',
  'essay-03-the-mask-we-all-wear': 'the-mask-we-all-wear',
  'essay-04-the-internet-that-pays-you-back': 'the-internet-that-pays-you-back',
  'essay-05-you-dont-need-ads': 'you-dont-need-ads',
  'essay-06-the-guild': 'the-guild',
  'essay-07-utility': 'the-utility',
  'essay-11-interstitial-01-cult-of-vetteses': 'cult-of-family',
  'essay-08-ticketing': 'the-ticket-is-the-trust',
  'essay-09-nodes-types-and-practice': 'the-practice',
  'essay-10-memory': 'memory',
  'essay-12-you-already-know-something': 'you-already-know-something',
  'essay-13-how-to-use-ai-properly': 'how-to-use-ai-properly',
  'essay-15-interstitial-02-cult-of-good-times': 'cult-of-good-times',
  'essay-16-how-to-save-education': 'how-to-save-education',
  'essay-17-how-to-save-journalism': 'how-to-save-journalism',
  'essay-18-how-to-save-the-music-industry': 'how-to-save-the-music-industry',
  'essay-19-how-to-save-the-ad-industry': 'how-to-save-the-ad-industry',
  'essay-20-how-to-save-the-platforms': 'how-to-save-the-platforms',
  'essay-21-how-to-save-media-streaming': 'how-to-save-media-streaming',
  'essay-14-honor-the-chain': 'honor-the-chain',
  'essay-22-interstitial-03-cult-of-community': 'cult-of-community',
  'essay-23-imajin-business-case': 'the-business-case',
  'essay-24-revenue-from-day-one': 'revenue-from-day-one',
  'essay-25-the-connector': 'the-connector',
  'essay-26-part-1-the-blueprint': 'the-blueprint',
  'essay-26-part-2-need-help': 'i-need-help',
  'essay-27-around-not-up': 'around-not-up',
  'essay-28-how-ai-saved-me': 'how-ai-saved-me',
  'essay-29-how-partying-can-save-us': 'how-partying-can-save-us',
  'essay-30-epilogue': 'epilogue',
};

// Reverse map: URL slug -> filename (without .md)
const reverseSlugMap: Record<string, string> = Object.entries(slugMap).reduce(
  (acc, [filename, slug]) => {
    acc[slug] = filename;
    return acc;
  },
  {} as Record<string, string>
);

// Order is determined by position in slugMap, not filename number.
// This lets us reorder essays by rearranging slugMap entries.
const slugMapKeys = Object.keys(slugMap);

function getOrderFromSlugMap(filename: string): number {
  const baseName = filename.replace('.md', '');
  const idx = slugMapKeys.indexOf(baseName);
  return idx >= 0 ? idx : 999;
}

export function getAllArticleSlugs(): string[] {
  const filenames = fs.readdirSync(articlesDirectory);
  return filenames
    .filter((name) => name.startsWith('essay-') && name.endsWith('.md'))
    .map((name) => {
      const baseName = name.replace('.md', '');
      return slugMap[baseName];
    })
    .filter(Boolean);
}

export function getAllArticles(): ArticleMeta[] {
  const filenames = fs.readdirSync(articlesDirectory);
  const articles = filenames
    .filter((name) => name.startsWith('essay-') && name.endsWith('.md'))
    .map((filename) => {
      const baseName = filename.replace('.md', '');
      const slug = slugMap[baseName] || baseName;
      const fullPath = path.join(articlesDirectory, filename);
      const fileContents = fs.readFileSync(fullPath, 'utf8');
      const { data, content } = matter(fileContents);

      // Extract title from first H1 if not in frontmatter
      let title = data.title;
      let subtitle = data.subtitle;
      if (!title) {
        const h1Match = content.match(/^#\s+(.+)$/m);
        title = h1Match ? h1Match[1] : baseName;
      }

      // Extract description from content if not in frontmatter
      let description = data.description;
      if (!description) {
        // Get first paragraph that isn't a heading
        const paragraphs = content.split('\n\n');
        for (const p of paragraphs) {
          const trimmed = p.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
            description = trimmed.slice(0, 200) + (trimmed.length > 200 ? '...' : '');
            break;
          }
        }
      }

      return {
        slug,
        title,
        subtitle,
        description: description || '',
        date: data.date || '2026-02-22',
        author: data.author || 'Ryan Veteze',
        status: (data.status as ArticleStatus) || 'DRAFT',
        order: getOrderFromSlugMap(filename),
      };
    })
    .filter((a) => a.status === 'POSTED')
    .sort((a, b) => a.order - b.order);

  return articles;
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const baseName = reverseSlugMap[slug];
  if (!baseName) {
    return null;
  }

  const fullPath = path.join(articlesDirectory, `${baseName}.md`);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data, content } = matter(fileContents);

  // Extract title from first H1 if not in frontmatter
  let title = data.title;
  let subtitle = data.subtitle;
  if (!title) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    title = h1Match ? h1Match[1] : baseName;
  }

  // Extract description from content if not in frontmatter
  let description = data.description;
  if (!description) {
    const paragraphs = content.split('\n\n');
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        description = trimmed.slice(0, 200) + (trimmed.length > 200 ? '...' : '');
        break;
      }
    }
  }

  // Remove the first H1 from content to avoid duplicate title
  const contentWithoutTitle = content.replace(/^#\s+.+\n+/, '');
  
  // Process markdown to HTML
  const processedContent = await remark()
    .use(remarkGfm)
    .use(html, { sanitize: false })
    .process(contentWithoutTitle);
  const contentHtml = processedContent.toString();

  return {
    slug,
    title,
    subtitle,
    description: description || '',
    date: data.date || '2026-02-22',
    author: data.author || 'Ryan Veteze',
    status: (data.status as ArticleStatus) || 'DRAFT',
    order: getOrderFromSlugMap(baseName),
    content,
    contentHtml,
  };
}
