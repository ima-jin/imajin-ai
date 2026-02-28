import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import html from 'remark-html';

// Articles directory - lives in apps/www/articles
const articlesDirectory = path.join(process.cwd(), 'articles');

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
  'essay-08-the-burn': 'the-burn',
  'essay-09-the-network': 'the-network',  
  'essay-10-the-bridge': 'the-bridge',
  'essay-11-ticketing': 'ticketing',
  'essay-12-nodes-types-and-practice': 'the-practice',
  'essay-13-memory': 'memory',
  'essay-14-how-to-save-the-ad-industry': 'how-to-save-the-ad-industry',
  'essay-15-how-to-save-the-music-industry': 'how-to-save-the-music-industry',
  'essay-16-how-to-save-journalism': 'how-to-save-journalism',
  'essay-17-imajin-business-case': 'the-business-case',
  'essay-18-honor-the-chain': 'honor-the-chain',
  'essay-19-the-connector': 'the-connector',
  'essay-20-i-need-help': 'i-need-help',
};

// Reverse map: URL slug -> filename (without .md)
const reverseSlugMap: Record<string, string> = Object.entries(slugMap).reduce(
  (acc, [filename, slug]) => {
    acc[slug] = filename;
    return acc;
  },
  {} as Record<string, string>
);

function getOrderFromFilename(filename: string): number {
  const match = filename.match(/essay-(\d+)/);
  return match ? parseInt(match[1], 10) : 999;
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
        order: getOrderFromFilename(filename),
      };
    })
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
    order: getOrderFromFilename(baseName),
    content,
    contentHtml,
  };
}
