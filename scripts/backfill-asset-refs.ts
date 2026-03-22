/**
 * Backfill asset references from legacy URL strings to asset IDs.
 *
 * For each service, queries rows that have a URL but no assetId,
 * extracts the asset ID from the URL (e.g. /api/assets/asset_xxx/content → asset_xxx),
 * updates the row with the extracted ID, and registers the reference with media.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-asset-refs.ts [--dry-run]
 */

const DRY_RUN = process.argv.includes('--dry-run');
const MEDIA_BASE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:3004';
const INTERNAL_API_KEY = process.env.AUTH_INTERNAL_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL!;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

import postgres from 'postgres';

const sql = postgres(DATABASE_URL);

/** Extract asset ID from a media content URL */
function extractAssetId(url: string | null): string | null {
  if (!url) return null;
  const match = /\/api\/assets\/(asset_[^/]+)\/content/.exec(url);
  return match ? match[1] : null;
}

/** Register an asset reference with the media service */
async function registerRef(assetId: string, service: string, entityType: string, entityId: string): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry-run] register ref: ${assetId} → ${service}/${entityType}/${entityId}`);
    return;
  }
  try {
    const res = await fetch(`${MEDIA_BASE_URL}/api/assets/${assetId}/references`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INTERNAL_API_KEY}`,
      },
      body: JSON.stringify({ service, entityType, entityId }),
    });
    if (!res.ok) {
      console.warn(`  warn: register ref failed ${res.status} for ${assetId}`);
    }
  } catch (err) {
    console.warn(`  warn: register ref error for ${assetId}:`, err);
  }
}

async function backfillCoffee() {
  console.log('\n=== coffee ===');
  const rows = await sql`
    SELECT id, avatar FROM coffee.pages
    WHERE avatar LIKE '%/api/assets/%/content%' AND avatar_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.avatar);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE coffee.pages SET avatar_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'coffee', 'page', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function backfillLinks() {
  console.log('\n=== links ===');
  const rows = await sql`
    SELECT id, avatar FROM links.pages
    WHERE avatar LIKE '%/api/assets/%/content%' AND avatar_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.avatar);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE links.pages SET avatar_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'links', 'page', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function backfillLearn() {
  console.log('\n=== learn ===');
  const rows = await sql`
    SELECT id, image_url FROM learn.courses
    WHERE image_url LIKE '%/api/assets/%/content%' AND image_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.image_url);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE learn.courses SET image_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'learn', 'course', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function backfillEvents() {
  console.log('\n=== events ===');
  const rows = await sql`
    SELECT id, image_url FROM events.events
    WHERE image_url LIKE '%/api/assets/%/content%' AND image_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.image_url);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE events.events SET image_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'events', 'event', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function backfillProfile() {
  console.log('\n=== profile ===');
  const rows = await sql`
    SELECT did, avatar FROM profile.profiles
    WHERE avatar LIKE '%/api/assets/%/content%' AND avatar_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.avatar);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE profile.profiles SET avatar_asset_id = ${assetId} WHERE did = ${row.did}`;
    }
    await registerRef(assetId, 'profile', 'profile', row.did);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.did} → ${assetId}`);
  }
}

async function backfillAuth() {
  console.log('\n=== auth ===');
  const rows = await sql`
    SELECT id, avatar_url FROM auth.identities
    WHERE avatar_url LIKE '%/api/assets/%/content%' AND avatar_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.avatar_url);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE auth.identities SET avatar_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'auth', 'identity', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function backfillMarket() {
  console.log('\n=== market ===');
  const rows = await sql`
    SELECT id, images FROM market.listings
    WHERE images IS NOT NULL AND image_asset_ids = '[]'::jsonb
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const urls: string[] = Array.isArray(row.images) ? row.images : [];
    const assetIds = urls.map(extractAssetId).filter(Boolean) as string[];
    if (assetIds.length === 0) continue;
    if (!DRY_RUN) {
      await sql`UPDATE market.listings SET image_asset_ids = ${JSON.stringify(assetIds)}::jsonb WHERE id = ${row.id}`;
    }
    for (const assetId of assetIds) {
      await registerRef(assetId, 'market', 'listing', row.id);
    }
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → [${assetIds.join(', ')}]`);
  }
}

async function backfillChat() {
  console.log('\n=== chat ===');
  const rows = await sql`
    SELECT id, media_path FROM chat.messages_v2
    WHERE media_path LIKE '%/api/assets/%/content%' AND media_asset_id IS NULL
  `;
  console.log(`  ${rows.length} rows to backfill`);
  for (const row of rows) {
    const assetId = extractAssetId(row.media_path);
    if (!assetId) continue;
    if (!DRY_RUN) {
      await sql`UPDATE chat.messages_v2 SET media_asset_id = ${assetId} WHERE id = ${row.id}`;
    }
    await registerRef(assetId, 'chat', 'message', row.id);
    console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} → ${assetId}`);
  }
}

async function main() {
  console.log(`Backfill asset references${DRY_RUN ? ' (DRY RUN)' : ''}`);
  try {
    await backfillCoffee();
    await backfillLinks();
    await backfillLearn();
    await backfillEvents();
    await backfillProfile();
    await backfillAuth();
    await backfillMarket();
    await backfillChat();
    console.log('\nDone.');
  } finally {
    await sql.end();
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
