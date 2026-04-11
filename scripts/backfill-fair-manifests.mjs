#!/usr/bin/env node
/**
 * Backfill .fair manifests on all events using buildFairManifest.
 * 
 * Usage: 
 *   node scripts/backfill-fair-manifests.mjs              # dry run (default)
 *   node scripts/backfill-fair-manifests.mjs --apply       # actually update
 *   node scripts/backfill-fair-manifests.mjs --env prod    # use prod DB
 *
 * Reads DATABASE_URL from apps/events/.env.local (or apps/kernel/.env.local).
 * Respects each event's creator DID and scope (if any).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');
const envFlag = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'dev';

// Load DATABASE_URL
const envPaths = [
  resolve(baseDir, 'apps/events/.env.local'),
  resolve(baseDir, 'apps/kernel/.env.local'),
];

let databaseUrl;
for (const envPath of envPaths) {
  try {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^DATABASE_URL=["']?(.+?)["']?\s*$/m);
    if (match?.[1]) { databaseUrl = match[1]; break; }
  } catch { /* skip */ }
}

databaseUrl = databaseUrl || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('❌ No DATABASE_URL found');
  process.exit(1);
}

// Fee constants (match packages/fair/src/constants.ts)
const PROTOCOL_FEE_BPS = 100;    // 1.0%
const PROTOCOL_DID = 'did:imajin:c6e6c109db4a1cc52995c0836f73cc6833d7e4624bc86e048118d72820873213';
const NODE_FEE_DEFAULT_BPS = 50;  // 0.5%
const BUYER_CREDIT_DEFAULT_BPS = 25; // 0.25%

function bpsToShare(bps) { return bps / 10000; }

function buildManifest(creatorDid, contentDid, scopeDid, scopeFeeBps) {
  const protocolShare = bpsToShare(PROTOCOL_FEE_BPS);
  const nodeShare = bpsToShare(NODE_FEE_DEFAULT_BPS);
  const buyerCreditShare = bpsToShare(BUYER_CREDIT_DEFAULT_BPS);
  const hasScopeFee = !!(scopeDid && scopeFeeBps != null);
  const scopeShare = hasScopeFee ? bpsToShare(scopeFeeBps) : 0;
  const sellerShare = 1 - protocolShare - nodeShare - buyerCreditShare - scopeShare;

  const chain = [
    { did: PROTOCOL_DID, role: 'protocol', share: protocolShare },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: nodeShare },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: buyerCreditShare },
  ];

  if (hasScopeFee) {
    chain.push({ did: scopeDid, role: 'scope', share: scopeShare });
  }

  chain.push({ did: creatorDid, role: 'seller', share: sellerShare });

  return {
    version: '0.3.0',
    chain,
    distributions: [{ did: creatorDid, role: 'creator', share: 1.0 }],
  };
}

// Connect to DB
const postgres = (await import('postgres')).default;
const sql = postgres(databaseUrl, { max: 1 });

try {
  console.log(`${dryRun ? '🔍 DRY RUN' : '🔥 APPLYING'} — backfill .fair manifests (${envFlag})\n`);

  // Get all events with their creator DID
  const events = await sql`
    SELECT e.id, e.did, e.creator_did, e.title, e.metadata,
           gi.scope as group_scope,
           fc.scope_fee_bps
    FROM events.events e
    LEFT JOIN auth.group_identities gi ON gi.group_did = e.creator_did
    LEFT JOIN profile.forest_config fc ON fc.group_did = e.creator_did
    ORDER BY e.created_at
  `;

  console.log(`Found ${events.length} events\n`);

  let updated = 0;
  let skipped = 0;

  for (const event of events) {
    const metadata = event.metadata || {};
    const currentFair = metadata.fair;
    const currentVersion = currentFair?.version;

    // Skip if already v0.3.0
    if (currentVersion === '0.3.0') {
      console.log(`  ✓ ${event.id} "${event.title}" — already v0.3.0, skipping`);
      skipped++;
      continue;
    }

    const manifest = buildManifest(
      event.creator_did,
      event.did,
      event.group_scope ? event.creator_did : null,
      event.scope_fee_bps
    );

    console.log(`  → ${event.id} "${event.title}"`);
    console.log(`    creator: ${event.creator_did.slice(0, 30)}...`);
    console.log(`    old version: ${currentVersion || 'none'}`);
    console.log(`    new chain: ${manifest.chain.map(e => `${e.role}(${(e.share * 100).toFixed(2)}%)`).join(' + ')}`);

    if (!dryRun) {
      const newMetadata = { ...metadata, fair: manifest };
      await sql`
        UPDATE events.events 
        SET metadata = ${JSON.stringify(newMetadata)}::jsonb, 
            updated_at = NOW()
        WHERE id = ${event.id}
      `;
      console.log(`    ✅ updated`);
    } else {
      console.log(`    (dry run — no changes)`);
    }

    updated++;
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
  if (dryRun && updated > 0) {
    console.log(`\nRun with --apply to actually update the database.`);
  }

} catch (err) {
  console.error('❌ Error:', err);
  process.exit(1);
} finally {
  await sql.end();
}
