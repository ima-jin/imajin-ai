import type { McpTool } from '../types';
import { str, json } from './utils';
import * as bus from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { createAsset, inferMime, isAllowedMime } from '@/src/lib/media/create-asset';
import { buildArticleBlock, deriveArticleProjection } from '../../media/article-core';
import { composeArticleFile } from '../../media/frontmatter';
import { updateAssetContent } from '@/src/lib/media/update-asset';

/**
 * Media WRITE tools for the MCP connector (#1170). All require the 'media:write'
 * scope (enforced per-tool in handleMcpRpc) and act only on the caller's own DID.
 *
 * - media_create_note / media_create_article / media_upload: CREATE new assets
 *   owner-pinned to ctx.did via the in-process createAsset lib (no HTTP
 *   self-call), with dedup DISABLED so a write can never return or mutate
 *   another DID's asset, and access pinned to 'private' so MCP-created media
 *   never inherits a public-implying context. media_create_article writes YAML
 *   frontmatter into the file (source of truth, #1193) and defaults to DRAFT;
 *   media_create_note is plain capture with no article treatment.
 * - media_update: owner-only content UPDATE (new version) via updateAssetContent;
 *   the versioning substrate (#1122/#1123) handles the new CID + Lore revision,
 *   and re-derives metadata.article from the file's frontmatter on write.
 *
 * Delegated cross-DID writes remain out of scope (see write-access.ts).
 */

const log = createLogger('kernel');

/** Hard cap on tool-supplied uploads (MCP args are JSON; bytes arrive base64). */
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;


const createNoteTool: McpTool = {
  name: 'media_create_note',
  requiredScope: 'media:write',
  description:
    'Create a new PRIVATE plain-text Markdown NOTE owned by your DID. Use this for quick capture: freeform notes, snippets, or drafts with no publishing intent. Content only — no title, slug, status, or article frontmatter is added, and a note never appears on the public site. Use media_create_article instead when you want a titled, publishable article. Create-only: always makes a new asset.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown body' },
      filename: { type: 'string', description: 'Optional filename; defaults to note-<timestamp>.md' },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const content = str(args, 'content');
    if (content === undefined) throw new Error('content is required');

    const requestedName = str(args, 'filename') ?? `note-${Date.now()}.md`;
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

    return json({
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      access: 'private',
      ownerDid: asset.ownerDid,
      cid: asset.cid,
      createdAt: asset.createdAt,
    });
  },
};

const createArticleTool: McpTool = {
  name: 'media_create_article',
  requiredScope: 'media:write',
  description:
    'Create a new PRIVATE, PUBLISHABLE Markdown article owned by your DID. Generates YAML frontmatter (slug, title, status, date, …) into the file body — the file is self-describing and is the source of truth. Defaults to status DRAFT: the article is NOT visible on the public site until explicitly promoted to POSTED. Use media_create_note instead for plain notes with no publishing intent. Create-only: always makes a new asset.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Article title' },
      slug: { type: 'string', description: 'URL-safe slug (a-z, 0-9, hyphens only)' },
      content: { type: 'string', description: 'Markdown body' },
      subtitle: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', enum: ['POSTED', 'REVIEW', 'DRAFT'], description: 'Defaults to DRAFT when omitted' },
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

    // Frontmatter is the source of truth: write it into the file body, then
    // re-derive the DB projection from those same bytes (#1193).
    const fileContent = composeArticleFile(article, content);

    const { asset } = await createAsset({
      ownerDid: ctx.did,
      uploadedBy: ctx.did,
      buffer: Buffer.from(fileContent, 'utf8'),
      filename,
      mimeType: 'text/markdown',
      access: 'private',
      dedup: false,
      classify: false,
    });

    await deriveArticleProjection(asset.id, fileContent, asset.metadata);

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

const updateTool: McpTool = {
  name: 'media_update',
  requiredScope: 'media:write',
  description:
    'Overwrite the text content of an existing text asset you own, creating a new version (the asset id stays the same). Owner-only.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Asset id (asset_...) to update' },
      content: { type: 'string', description: 'New UTF-8 text content (replaces the current content)' },
    },
    required: ['id', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = str(args, 'id');
    if (!id) throw new Error('id is required');
    // content may be an empty string (clears the file), so this can't use str().
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (content === undefined) throw new Error('content is required');

    const result = await updateAssetContent({
      assetId: id,
      requesterDid: ctx.did,
      content,
      requireTextMime: true,
    });
    if (!result.ok) throw new Error(result.message);

    const a = result.asset;
    return json({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      versionCount: a.versionCount,
      cid: a.cid,
      updatedAt: a.updatedAt,
    });
  },
};

export const mediaWriteTools: McpTool[] = [createNoteTool, createArticleTool, uploadTool, updateTool];
