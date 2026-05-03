#!/usr/bin/env node
/**
 * repair-connections.mjs
 * 
 * Fixes data corruption from missing `and` import in invite accept route.
 * Bug: commit efd10596 (Apr 10) introduced `and()` without importing it.
 * Deployed with event bus merge (Apr 23). Accept route crashed after creating
 * pod but before inserting connection row and updating invite status.
 * 
 * This script:
 * 1. Finds personal pods with 2 members but no connections row → inserts connection
 * 2. Finds the best-matching pending invite for each affected pair → marks as accepted
 * 3. Removes duplicate pods for the same connection pair (keeps earliest)
 * 
 * Usage: DATABASE_URL=... node scripts/repair-connections.mjs [--dry-run]
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const sql = postgres(DATABASE_URL);

async function main() {
  console.log(`\n🔧 Connection repair script ${dryRun ? '(DRY RUN)' : '(LIVE)'}\n`);

  // 1. Find pods with missing connection rows
  const missingConnections = await sql`
    SELECT p.id as pod_id, p.name, p.created_at,
           pm1.did as did1, pm2.did as did2,
           LEAST(pm1.did, pm2.did) as did_a,
           GREATEST(pm1.did, pm2.did) as did_b
    FROM connections.pods p
    JOIN connections.pod_members pm1 ON pm1.pod_id = p.id
    JOIN connections.pod_members pm2 ON pm2.pod_id = p.id AND pm2.did > pm1.did
    WHERE p.type = 'personal'
    AND NOT EXISTS (
      SELECT 1 FROM connections.connections c
      WHERE c.did_a = LEAST(pm1.did, pm2.did)
        AND c.did_b = GREATEST(pm1.did, pm2.did)
    )
    ORDER BY p.created_at
  `;

  console.log(`📋 Found ${missingConnections.length} pods with missing connection rows:`);
  for (const mc of missingConnections) {
    console.log(`   ${mc.name} (${mc.created_at.toISOString().slice(0,10)})`);
  }

  // Insert missing connections (deduplicated)
  const seenPairs = new Set();
  let connectionsInserted = 0;
  for (const mc of missingConnections) {
    const pairKey = `${mc.did_a}|${mc.did_b}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    if (!dryRun) {
      await sql`
        INSERT INTO connections.connections (did_a, did_b)
        VALUES (${mc.did_a}, ${mc.did_b})
        ON CONFLICT DO NOTHING
      `;
    }
    connectionsInserted++;
    console.log(`   ✅ Connection: ${mc.name}`);
  }
  console.log(`\n📊 Connections inserted: ${connectionsInserted}\n`);

  // 2. Find pending invites that should be accepted
  // For each pod pair created after Apr 22, find the best matching pending invite
  const unacceptedPods = await sql`
    WITH pod_pairs AS (
      SELECT DISTINCT ON (LEAST(pm1.did, pm2.did), GREATEST(pm1.did, pm2.did))
        p.id as pod_id, p.name, p.created_at, p.owner_did,
        pm1.did as inviter_did,
        pm2.did as accepter_did
      FROM connections.pods p
      JOIN connections.pod_members pm1 ON pm1.pod_id = p.id AND pm1.did = p.owner_did
      JOIN connections.pod_members pm2 ON pm2.pod_id = p.id AND pm2.did != p.owner_did
      WHERE p.type = 'personal'
      AND p.created_at > '2026-04-22'
      ORDER BY LEAST(pm1.did, pm2.did), GREATEST(pm1.did, pm2.did), p.created_at ASC
    )
    SELECT pp.*,
      -- Check if there's already an accepted invite for this pair
      EXISTS (
        SELECT 1 FROM connections.invites i
        WHERE i.from_did = pp.inviter_did
        AND i.consumed_by = pp.accepter_did
        AND i.status = 'accepted'
      ) as already_accepted
    FROM pod_pairs pp
    WHERE NOT EXISTS (
      SELECT 1 FROM connections.invites i
      WHERE i.from_did = pp.inviter_did
      AND i.consumed_by = pp.accepter_did
      AND i.status = 'accepted'
    )
    ORDER BY pp.created_at
  `;

  console.log(`📋 Found ${unacceptedPods.length} connections with no accepted invite:`);
  let invitesFixed = 0;

  for (const pod of unacceptedPods) {
    // Find the best matching pending invite:
    // - From the inviter
    // - Status = pending
    // - Created before the pod was created
    // - Prefer closest in time to pod creation
    const [bestInvite] = await sql`
      SELECT id, code, created_at, delivery
      FROM connections.invites
      WHERE from_did = ${pod.inviter_did}
      AND status = 'pending'
      AND used_count < max_uses
      AND created_at < ${pod.created_at}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!bestInvite) {
      console.log(`   ⚠️  ${pod.name} — no matching pending invite found`);
      continue;
    }

    console.log(`   🎯 ${pod.name} → invite ${bestInvite.code.slice(0,8)}... (${bestInvite.delivery}, ${bestInvite.created_at.toISOString().slice(0,10)})`);

    if (!dryRun) {
      await sql`
        UPDATE connections.invites
        SET status = 'accepted',
            accepted_at = ${pod.created_at.toISOString()},
            used_count = used_count + 1,
            consumed_by = ${pod.accepter_did},
            to_did = ${pod.accepter_did}
        WHERE id = ${bestInvite.id}
      `;
    }
    invitesFixed++;
  }
  console.log(`\n📊 Invites fixed: ${invitesFixed}\n`);

  // 3. Find and remove duplicate pods for the same pair
  const duplicatePods = await sql`
    WITH ranked AS (
      SELECT p.id, p.name, p.created_at,
             LEAST(pm1.did, pm2.did) as pair_a,
             GREATEST(pm1.did, pm2.did) as pair_b,
             ROW_NUMBER() OVER (
               PARTITION BY LEAST(pm1.did, pm2.did), GREATEST(pm1.did, pm2.did)
               ORDER BY p.created_at ASC
             ) as rn
      FROM connections.pods p
      JOIN connections.pod_members pm1 ON pm1.pod_id = p.id
      JOIN connections.pod_members pm2 ON pm2.pod_id = p.id AND pm2.did > pm1.did
      WHERE p.type = 'personal'
    )
    SELECT id, name, created_at
    FROM ranked
    WHERE rn > 1
    ORDER BY created_at
  `;

  console.log(`📋 Found ${duplicatePods.length} duplicate pods to clean up:`);
  for (const dp of duplicatePods) {
    console.log(`   🗑️  ${dp.name} (${dp.created_at.toISOString().slice(0,10)}) → ${dp.id}`);
  }

  if (duplicatePods.length > 0 && !dryRun) {
    const dupIds = duplicatePods.map(d => d.id);
    // pod_members will cascade delete
    await sql`DELETE FROM connections.pods WHERE id = ANY(${dupIds})`;
    console.log(`\n📊 Duplicate pods removed: ${duplicatePods.length}\n`);
  } else {
    console.log(`\n📊 Duplicate pods to remove: ${duplicatePods.length} ${dryRun ? '(skipped - dry run)' : ''}\n`);
  }

  console.log('✨ Done!\n');
  await sql.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
