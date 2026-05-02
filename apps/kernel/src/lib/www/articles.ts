import fs from 'fs';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import html from 'remark-html';
import { db, assets, identities } from '@/src/db';
import { sql, eq } from 'drizzle-orm';

export type ArticleStatus = 'POSTED' | 'REVIEW' | 'DRAFT';

export interface ArticleMeta {
  slug: string;
  title: string;
  subtitle?: string;
  description: string;
  date: string;
  author: string;
  authorHandle: string | null;
  status: ArticleStatus;
  order: number;
}

export interface Article extends ArticleMeta {
  content: string;
  contentHtml: string;
}

export interface AuthorInfo {
  did: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * Resolve a handle to a DID. Returns null if not found.
 */
export async function resolveHandle(handle: string): Promise<AuthorInfo | null> {
  const [row] = await db
    .select({
      id: identities.id,
      handle: identities.handle,
      name: identities.name,
      avatarUrl: identities.avatarUrl,
    })
    .from(identities)
    .where(eq(identities.handle, handle))
    .limit(1);

  if (!row || !row.handle) return null;

  return {
    did: row.id,
    handle: row.handle,
    name: row.name,
    avatarUrl: row.avatarUrl,
  };
}

// Parse article metadata from a DB asset row
function parseArticleMeta(row: {
  metadata: Record<string, unknown> | null;
  ownerDid: string;
  authorHandle?: string | null;
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
    author: (article.author as string) || 'Unknown',
    authorHandle: row.authorHandle ?? null,
    status: (article.status as ArticleStatus) || 'DRAFT',
    order: typeof article.order === 'number' ? article.order : 999,
  };
}

/**
 * Get all POSTED articles across all authors, date descending.
 */
export async function getAllArticles(): Promise<ArticleMeta[]> {
  const rows = await db
    .select({
      metadata: assets.metadata,
      ownerDid: assets.ownerDid,
      authorHandle: identities.handle,
    })
    .from(assets)
    .leftJoin(identities, eq(assets.ownerDid, identities.id))
    .where(
      sql`${assets.mimeType} = ${'text/markdown'}
        AND ${assets.status} = ${'active'}
        AND ${assets.metadata}->'article'->>'status' = ${'POSTED'}`
    )
    .orderBy(sql`(${assets.metadata}->'article'->>'date')::date DESC`);

  return rows
    .map(parseArticleMeta)
    .filter((meta): meta is ArticleMeta => meta !== null);
}

/**
 * Get all POSTED articles for a specific author (by DID), date descending.
 */
export async function getArticlesByAuthor(ownerDid: string): Promise<ArticleMeta[]> {
  const rows = await db
    .select({
      metadata: assets.metadata,
      ownerDid: assets.ownerDid,
      authorHandle: identities.handle,
    })
    .from(assets)
    .leftJoin(identities, eq(assets.ownerDid, identities.id))
    .where(
      sql`${assets.ownerDid} = ${ownerDid}
        AND ${assets.mimeType} = ${'text/markdown'}
        AND ${assets.status} = ${'active'}
        AND ${assets.metadata}->'article'->>'status' = ${'POSTED'}`
    )
    .orderBy(sql`(${assets.metadata}->'article'->>'date')::date DESC`);

  return rows
    .map(parseArticleMeta)
    .filter((meta): meta is ArticleMeta => meta !== null);
}

/**
 * Get all POSTED article slugs (global).
 */
export async function getAllArticleSlugs(): Promise<{ handle: string; slug: string }[]> {
  const rows = await db
    .select({
      metadata: assets.metadata,
      authorHandle: identities.handle,
    })
    .from(assets)
    .leftJoin(identities, eq(assets.ownerDid, identities.id))
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
      const slug = article?.slug as string | undefined;
      const handle = row.authorHandle;
      if (!slug || !handle) return null;
      return { handle, slug };
    })
    .filter((item): item is { handle: string; slug: string } => item !== null);
}

/**
 * Get a single article by author DID + slug.
 */
export async function getArticleBySlug(ownerDid: string, slug: string): Promise<Article | null> {
  const [row] = await db
    .select({
      id: assets.id,
      metadata: assets.metadata,
      storagePath: assets.storagePath,
      ownerDid: assets.ownerDid,
      authorHandle: identities.handle,
    })
    .from(assets)
    .leftJoin(identities, eq(assets.ownerDid, identities.id))
    .where(
      sql`${assets.ownerDid} = ${ownerDid}
        AND ${assets.mimeType} = ${'text/markdown'}
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
    authorHandle: meta.authorHandle,
    status: (data.status as ArticleStatus) || meta.status,
    order: meta.order,
    content,
    contentHtml,
  };
}
