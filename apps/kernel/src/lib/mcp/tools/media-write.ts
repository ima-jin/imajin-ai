import type { McpTool, McpContent } from '../types';
import { db, assets } from '@/src/db';
import { eq } from 'drizzle-orm';
import * as bus from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { createAsset, inferMime, isAllowedMime } from '@/src/lib/media/create-asset';
import { buildArticleBlock, mergeArticleMetadata } from '@/src/lib/media/routes/article';

/**
 * Media WRITE tools for the MCP connector (#1170, Stage 1 — CREATE-ONLY).
 *
 * Both tools require the 'media:write' scope (enforced per-tool in handleMcpRpc)
 * and create NEW assets owner-pinned to ctx.did with a fresh, signed `.fair`
 * manifest. They go through the in-process createAsset lib (no HTTP self-call)
 * with dedup DISABLED so a write can never return or mutate another DID's asset,
 * and access pinned to 'private' so MCP-created media never inherits a
 * public-implying app context. UPDATE / VERSION is deferred to Stage 2 (#1122).
 */

const log = createLogger('kernel');

/** Hard cap on tool-supplied uploads (MCP args are JSON; bytes arrive base64). */
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function json(value: unknown): McpContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

const createTextTool: McpTool = {
  name: 'media_create_text',
  requiredScope: 'media:write',
  description:
    'Create a new private Markdown article owned by your DID. Stores the Markdown as a text/markdown asset and applies article metadata (slug, title, etc.). Create-only: always makes a new asset.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Article title' },
      slug: { type: 'string', description: 'URL-safe slug (a-z, 0-9, hyphens only)' },
      content: { type: 'string', description: 'Markdown body' },
      subtitle: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', enum: ['POSTED', 'REVIEW', 'DRAFT'] },
      date: { type: 'string', description: 'ISO date (YYYY-MM-DD); defaults to today' },
      order: { type: 'integer' },
      filename: { type: 'string', description: 'Optional filename; defaults to <slug>.md' },
    },
    required: ['title', 'slug', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const content = str(args, 'content');
    if (content === undefined) throw new Error('content is required');

    // Validate article fields up-front so we never create an orphan asset.
    const built = buildArticleBlock({
      slug: args.slug,
      title: args.title,
      subtitle: args.subtitle,
      description: args.description,
      status: args.status,
      date: args.date,
      order: args.order,
    });
    if ('error' in built) throw new Error(built.error);
    const article = built.block;

    const requestedName = str(args, 'filename') ?? `${article.slug}.md`;
    const filename = requestedName.endsWith('.md') ? requestedName : `${requestedName}.md`;

    const { asset } = await createAsset({
      ownerDid: ctx.did,
      uploadedBy: ctx.did,
      buffer: Buffer.from(content, 'utf8'),
      filename,
      mimeType: 'text/markdown',
      access: 'private',
      dedup: false,
      classify: false,
    });

    // Apply the article treatment in-process. Owner is ctx.did by construction,
    // so the patchArticle owner/mime guards are already satisfied.
    const metadata = mergeArticleMetadata(asset.metadata, article);
    await db.update(assets).set({ metadata, updatedAt: new Date() }).where(eq(assets.id, asset.id));

    try {
      await bus.publish('asset.article.published', {
        issuer: ctx.did,
        subject: ctx.did,
        scope: 'media',
        payload: {
          assetId: asset.id,
          slug: article.slug,
          title: article.title,
          status: article.status,
          date: article.date,
        },
      });
    } catch (err) {
      log.error({ err: String(err), assetId: asset.id }, 'asset.article.published failed (non-fatal)');
    }

    return json({
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      access: 'private',
      ownerDid: asset.ownerDid,
      cid: asset.cid,
      article,
      createdAt: asset.createdAt,
    });
  },
};

const uploadTool: McpTool = {
  name: 'media_upload',
  requiredScope: 'media:write',
  description:
    `Upload a new private asset owned by your DID from base64-encoded bytes (max ${MAX_UPLOAD_MB} MB). Create-only: always makes a new asset.`,
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Original filename (used for extension + MIME inference)' },
      data_base64: { type: 'string', description: 'Base64-encoded file bytes' },
      mimeType: { type: 'string', description: 'Optional MIME type; inferred from filename when omitted' },
    },
    required: ['filename', 'data_base64'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const filename = str(args, 'filename');
    if (!filename) throw new Error('filename is required');
    const dataB64 = str(args, 'data_base64');
    if (!dataB64) throw new Error('data_base64 is required');

    const buffer = Buffer.from(dataB64, 'base64');
    if (buffer.byteLength === 0) throw new Error('data_base64 decoded to empty content');
    if (buffer.byteLength > MAX_UPLOAD_BYTES) throw new Error(`File exceeds ${MAX_UPLOAD_MB} MB limit`);

    const mimeType = inferMime(str(args, 'mimeType') ?? '', filename);
    if (!isAllowedMime(mimeType)) throw new Error(`MIME type ${mimeType} is not allowed`);

    const { asset } = await createAsset({
      ownerDid: ctx.did,
      uploadedBy: ctx.did,
      buffer,
      filename,
      mimeType,
      access: 'private',
      dedup: false,
    });

    return json({
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      access: 'private',
      ownerDid: asset.ownerDid,
      cid: asset.cid,
      createdAt: asset.createdAt,
    });
  },
};

export const mediaWriteTools: McpTool[] = [createTextTool, uploadTool];
