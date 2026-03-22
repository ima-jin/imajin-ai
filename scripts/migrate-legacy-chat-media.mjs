#!/usr/bin/env node
/**
 * Migrate legacy chat media files from /mnt/media/chat/ into the media service.
 *
 * Usage: node scripts/migrate-legacy-chat-media.mjs [--dry-run]
 * Run from monorepo root so postgres import resolves.
 */

import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { extname, join } from 'path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const MEDIA_ROOT = '/mnt/media';
const LEGACY_CHAT_DIR = '/mnt/media/chat';
const DRY_RUN = process.argv.includes('--dry-run');

function didToPath(did) {
  return did.replace(/:/g, '_').replace(/[^a-zA-Z0-9._@-]/g, '_');
}

function nanoid(len = 16) {
  return randomBytes(len).toString('base64url').slice(0, len);
}

async function main() {
  const sql = postgres(DATABASE_URL);
  console.log(`Connected to database. ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}\n`);

  // Find all legacy media messages
  const legacyMessages = await sql`
    SELECT id, from_did, content_type, content, media_type, media_path, media_meta
    FROM chat.messages
    WHERE media_type IS NOT NULL AND media_path IS NOT NULL
    ORDER BY created_at ASC
  `;

  console.log(`Found ${legacyMessages.length} legacy media messages to migrate.\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const msg of legacyMessages) {
    const { id, from_did, media_type, media_path, media_meta } = msg;
    const meta = media_meta || {};
    const sourcePath = join(LEGACY_CHAT_DIR, media_path);

    console.log(`--- Message ${id} ---`);
    console.log(`  from: ${from_did}`);
    console.log(`  type: ${media_type}, path: ${media_path}`);

    if (!existsSync(sourcePath)) {
      console.log(`  ⚠ Source file not found: ${sourcePath} — SKIPPING`);
      skipped++;
      continue;
    }

    const buffer = await readFile(sourcePath);
    const hash = createHash('sha256').update(buffer).digest('hex');

    const assetId = `asset_${nanoid(16)}`;
    const ext = extname(media_path) || (meta.mimeType?.includes('png') ? '.png' : '.jpg');
    const didPath = didToPath(from_did);
    const dirPath = join(MEDIA_ROOT, didPath, 'assets');
    const storagePath = join(dirPath, `${assetId}${ext}`);
    const fairPath = join(dirPath, `${assetId}.fair.json`);

    const mimeType = meta.mimeType || (media_type === 'image' ? 'image/jpeg' : 'application/octet-stream');
    const filename = meta.originalName || media_path.split('/').pop() || 'file';
    const size = meta.size || buffer.length;

    const newContent = {
      type: 'media',
      assetId,
      filename,
      mimeType,
      size,
      ...(meta.width ? { width: meta.width } : {}),
      ...(meta.height ? { height: meta.height } : {}),
    };

    const fairManifest = {
      version: '0.2.0',
      asset: assetId,
      owner: from_did,
      access: 'private',
      attribution: [{ did: from_did, share: 100 }],
      transfer: { allowed: false },
      createdAt: new Date().toISOString(),
    };

    console.log(`  → assetId: ${assetId}`);
    console.log(`  → dest: ${storagePath}`);
    console.log(`  → content: ${JSON.stringify(newContent)}`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would migrate.\n`);
      migrated++;
      continue;
    }

    try {
      await mkdir(dirPath, { recursive: true });
      await copyFile(sourcePath, storagePath);
      await writeFile(fairPath, JSON.stringify(fairManifest, null, 2));

      await sql`
        INSERT INTO media.assets (id, owner_did, filename, mime_type, size, storage_path, hash, fair_manifest, fair_path, status, metadata, created_at, updated_at)
        VALUES (${assetId}, ${from_did}, ${filename}, ${mimeType}, ${size}, ${storagePath}, ${hash}, ${sql.json(fairManifest)}, ${fairPath}, 'active', ${sql.json({})}, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;

      await sql`
        UPDATE chat.messages
        SET content_type = 'media',
            content = ${JSON.stringify(newContent)}::jsonb,
            media_type = NULL,
            media_path = NULL,
            media_meta = NULL
        WHERE id = ${id}
      `;

      console.log(`  ✅ Migrated.\n`);
      migrated++;
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}\n`);
      errors++;
    }
  }

  console.log(`\n=== Migration complete ===`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);

  await sql.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
