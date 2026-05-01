import fs from 'fs';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';
import { db, assets } from '@/src/db';
import { sql } from 'drizzle-orm';

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

// Parse article metadata from a DB asset row
function parseArticleMeta(row: {
  metadata: Record<string, unknown> | null;
  storagePath: string | null;
}): ArticleMeta | null {
  const article = (row.metadata as Record<string, unknown> | null)?.article as
    | Record<string, unknown>
    | null;
  if (!article || typeof article !== 'object') return null;

  const slug = article.slug as string | undefined;
  if (!slug) return null;

  return {
    slug,
    title: (article.title as string) || slug,
    subtitle: (article.subtitle as string) || undefined,
    description: (article.description as string) || '',
    date: (article.date as string) || '2026-02-22',
    author: (article.author as string) || 'Ryan Veteze',
    status: (article.status as ArticleStatus) || 'DRAFT',
    order: typeof article.order === 'number' ? article.order : 999,
  };
}

export async function getAllArticles(): Promise<ArticleMeta[]> {
  const rows = await db
    .select({
      metadata: assets.metadata,
      storagePath: assets.storagePath,
    })
    .from(assets)
    .where(
      sql`${assets.mimeType} = ${'text/markdown'}
        AND ${assets.status} = ${'active'}
        AND ${assets.metadata}->'article'->>'status' = ${'POSTED'}`
    )
    .orderBy(sql`(${assets.metadata}->'article'->>'order')::int`);

  return rows
    .map(parseArticleMeta)
    .filter((meta): meta is ArticleMeta => meta !== null);
}

export async function getAllArticleSlugs(): Promise<string[]> {
  const rows = await db
    .select({ metadata: assets.metadata })
    .from(assets)
    .where(
      sql`${assets.mimeType} = ${'text/markdown'}
        AND ${assets.status} = ${'active'}
        AND ${assets.metadata}->'article'->>'status' = ${'POSTED'}`
    );

  return rows
    .map((row) => {
      const article = (row.metadata as Record<string, unknown> | null)?.article as
        | Record<string, unknown>
        | null;
      return article?.slug as string | undefined;
    })
    .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const [row] = await db
    .select({
      id: assets.id,
      metadata: assets.metadata,
      storagePath: assets.storagePath,
    })
    .from(assets)
    .where(
      sql`${assets.mimeType} = ${'text/markdown'}
        AND ${assets.status} = ${'active'}
        AND ${assets.metadata}->'article'->>'slug' = ${slug}`
    )
    .limit(1);

  if (!row || !row.storagePath) {
    return null;
  }

  const meta = parseArticleMeta(row);
  if (!meta) return null;

  if (!fs.existsSync(row.storagePath)) {
    return null;
  }

  const fileContents = fs.readFileSync(row.storagePath, 'utf8');
  const { data, content } = matter(fileContents);

  // Extract title from first H1 if not in frontmatter
  let title = data.title;
  let subtitle = data.subtitle;
  if (!title) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    title = h1Match ? h1Match[1] : meta.slug;
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
    slug: meta.slug,
    title: title || meta.title,
    subtitle: subtitle || meta.subtitle,
    description: description || meta.description,
    date: data.date || meta.date,
    author: data.author || meta.author,
    status: (data.status as ArticleStatus) || meta.status,
    order: meta.order,
    content,
    contentHtml,
  };
}
