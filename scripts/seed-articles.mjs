#!/usr/bin/env node
/**
 * Seed articles from docs/articles/essay-*.md into media.assets.
 *
 * Usage: node scripts/seed-articles.mjs
 * Environment:
 *   OWNER_DID   — required, DID of the article owner (e.g. Ryan's DID)
 *   MEDIA_ROOT  — optional, defaults to /mnt/media
 *
 * DATABASE_URL is read from apps/kernel/.env.local or env var.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');
const kernelDir = resolve(baseDir, 'apps', 'kernel');
const articlesDir = resolve(baseDir, 'docs', 'articles');
const kernelRequire = createRequire(join(kernelDir, 'index.js'));

const postgres = kernelRequire('postgres');
const matter = kernelRequire('gray-matter');
const { nanoid } = kernelRequire('nanoid');

// ─── Config ─────────────────────────────────────────────────────────────────

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/mnt/media';
const OWNER_DID = process.env.OWNER_DID;

if (!OWNER_DID) {
  console.error('❌ OWNER_DID environment variable is required');
  process.exit(1);
}

if (!existsSync(articlesDir)) {
  console.error(`❌ Articles directory not found: ${articlesDir}`);
  process.exit(1);
}

// Read DATABASE_URL from apps/kernel/.env.local, fallback to env var
const envPath = resolve(kernelDir, '.env.local');
let databaseUrl;
try {
  const envContent = readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^DATABASE_URL=["']?(.+?)["']?\s*$/m);
  databaseUrl = match?.[1];
} catch {
  // fall through
}
databaseUrl = databaseUrl || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(`❌ No DATABASE_URL found in ${envPath} or environment`);
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function didToPath(did) {
  return did.replace(/:/g, '_').replace(/[^a-zA-Z0-9._@-]/g, '_');
}

// Map essay filenames (without .md) to URL slugs and order
const slugMap = {
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
  'essay-31-the-receipt': 'the-receipt',
  'essay-32-how-to-save-compute': 'how-to-save-compute',
  'essay-33-this-is-how-you-fix-bitcoin-STUB': 'this-is-how-you-fix-bitcoin',
  'essay-34-how-to-save-the-app-store-STUB': 'how-to-save-the-app-store',
  'essay-35-the-architect-scorecard': 'the-architect-scorecard',
  'essay-36-come-peer-with-us': 'come-peer-with-us',
  'essay-37-how-to-fix-the-commons': 'how-to-fix-the-commons',
  'essay-38-the-inherited-pathology': 'the-inherited-pathology',
  'essay-39-interstitial-04-cult-of-work': 'cult-of-work',
  'essay-40-interstitial-05-the-verification-racket': 'the-verification-racket',
  'essay-41-what-imajin-is-building': 'what-imajin-is-building',
  'essay-42-the-catalog': 'the-catalog',
  'essay-43-show-us-the-receipts': 'show-us-the-receipts',
  'essay-44-the-missing-layer': 'the-missing-layer',
};

const slugMapKeys = Object.keys(slugMap);

function getOrderFromSlugMap(baseName) {
  const idx = slugMapKeys.indexOf(baseName);
  return idx >= 0 ? idx : 999;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  const didPath = didToPath(OWNER_DID);

  // Find or create "Articles" system folder
  const folderRows = await sql`
    SELECT id FROM media.folders
    WHERE owner_did = ${OWNER_DID}
      AND name = 'Articles'
      AND is_system = true
    LIMIT 1
  `;

  let folderId;
  if (folderRows.length > 0) {
    folderId = folderRows[0].id;
    console.log(`📁 Using existing Articles folder: ${folderId}`);
  } else {
    folderId = `folder_${nanoid(16)}`;
    await sql`
      INSERT INTO media.folders (id, owner_did, name, icon, is_system, sort_order)
      VALUES (${folderId}, ${OWNER_DID}, 'Articles', '📝', true, 0)
    `;
    console.log(`📁 Created Articles folder: ${folderId}`);
  }

  // Read all essay files
  const filenames = readdirSync(articlesDir)
    .filter((name) => name.startsWith('essay-') && name.endsWith('.md'))
    .sort();

  console.log(`\n📝 Found ${filenames.length} essay files\n`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const filename of filenames) {
    const baseName = filename.replace('.md', '');
    const slug = slugMap[baseName] || baseName;
    const order = getOrderFromSlugMap(baseName);

    const fullPath = join(articlesDir, filename);
    const content = readFileSync(fullPath, 'utf8');
    const { data } = matter(content);

    const hash = createHash('sha256').update(content).digest('hex');

    // Dedup: skip if same hash + owner already exists
    const existing = await sql`
      SELECT id FROM media.assets
      WHERE hash = ${hash} AND owner_did = ${OWNER_DID}
      LIMIT 1
    `;
    if (existing.length > 0) {
      console.log(`⏭  ${filename} — already exists (${existing[0].id})`);
      skipped++;
      continue;
    }

    const assetId = `asset_${nanoid(16)}`;
    const dirPath = join(MEDIA_ROOT, didPath, 'assets');
    const storagePath = join(dirPath, `${assetId}.md`);
    const fairPath = join(dirPath, `${assetId}.fair.json`);

    // Ensure directory exists
    mkdirSync(dirPath, { recursive: true });

    // Write file and .fair.json
    const fairManifest = {
      fair: '1.0',
      id: assetId,
      type: 'text/markdown',
      owner: OWNER_DID,
      created: new Date().toISOString(),
      source: 'seed',
      access: { type: 'public' },
      attribution: [{ did: OWNER_DID, role: 'creator', share: 1.0 }],
    };

    writeFileSync(storagePath, content);
    writeFileSync(fairPath, JSON.stringify(fairManifest, null, 2));

    const metadata = {
      article: {
        slug,
        title: data.title || null,
        subtitle: data.subtitle || null,
        description: data.description || null,
        date: data.date || null,
        author: data.author || 'Ryan Veteze',
        status: data.status || 'DRAFT',
        order,
      },
    };

    try {
      await sql`
        INSERT INTO media.assets (
          id, owner_did, filename, mime_type, size,
          storage_path, hash, fair_manifest, fair_path,
          metadata, status, classification
        ) VALUES (
          ${assetId}, ${OWNER_DID}, ${filename}, ${'text/markdown'}, ${Buffer.byteLength(content, 'utf8')},
          ${storagePath}, ${hash}, ${sql.json(fairManifest)}, ${fairPath},
          ${sql.json(metadata)}, ${'active'}, ${'document'}
        )
      `;

      // Link to folder
      await sql`
        INSERT INTO media.asset_folders (asset_id, folder_id)
        VALUES (${assetId}, ${folderId})
        ON CONFLICT DO NOTHING
      `;

      console.log(`✅ ${filename} → ${assetId} (${slug})`);
      inserted++;
    } catch (err) {
      console.error(`❌ ${filename} — insert failed: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n📊 Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);

  await sql.end();
}

try {
  await main();
} catch (err) {
  console.error('❌ Seed failed:', err.message ?? err);
  process.exit(1);
}
