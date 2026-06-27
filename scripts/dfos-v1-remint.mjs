#!/usr/bin/env node
/**
 * DFOS v1 corpus re-mint + foreign-gossip prune (#1111)
 *
 * Context: our relay binary is v1 (@metalabel/[email protected], idLength=31),
 * but the persisted corpus predates the bump — our identity chains carry
 * 22-char (pre-v1) did:dfos identifiers. A clean v1 peer re-derives them to
 * 31-char and our 22-char DIDs 404 on identity resolution. Brandon's 117th
 * conformance test (TestIdentifierWidthConformance) catches exactly this.
 *
 * This script, in ONE transaction:
 *   1. PRUNE  — delete every relay.* row NOT bound to one of our identity
 *               chains (auth.identity_chains.dfos_did). That foreign corpus is
 *               Brandon's gossiped/peered backfill: content-addressed, not
 *               bound to any Imajin user, re-replicates on re-peer. Safe.
 *   2. REMINT — for each of OUR chains whose dfos_did is still pre-v1 width,
 *               re-derive the canonical v1 did from the already-signed genesis
 *               op via the protocol lib (verifyIdentityChain). Same keypair,
 *               sigs stay valid, NO re-signing. did:imajin (base58 full-pubkey)
 *               does NOT move.
 *   3. REWRITE — update the new did everywhere it is referenced:
 *               auth.identity_chains.dfos_did, relay.relay_identity_chains.did,
 *               relay.relay_operations.chain_id, relay.relay_operation_log.chain_id,
 *               relay.relay_beacons.did, registry.nodes.chain_did.
 *
 * Dry-run by default. Pass --apply to commit.
 *
 * Usage:
 *   node scripts/dfos-v1-remint.mjs            # dry-run, prints plan
 *   node scripts/dfos-v1-remint.mjs --apply    # commit
 *   DATABASE_URL=... node scripts/dfos-v1-remint.mjs --apply
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyIdentityChain } from '@metalabel/dfos-protocol';
import envUtils from './env-utils.js';

const APPLY = process.argv.includes('--apply');
const DFOS_DID_PREFIX = 'did:dfos';
const V1_WIDTH = 31; // canonical v1 identifier suffix width

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');
const kernelDir = resolve(baseDir, 'apps', 'kernel');
const kernelRequire = createRequire(join(kernelDir, 'index.js'));
const postgres = kernelRequire('postgres');

const envPath = resolve(kernelDir, '.env.local');
const databaseUrl =
  envUtils.readEnvValueFromFile(envPath, 'DATABASE_URL') || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(`❌ No DATABASE_URL found in ${envPath} or environment`);
  process.exit(1);
}

const didWidth = did => (did?.split(':')[2] ?? '').length;

const sql = postgres(databaseUrl, { max: 1 });

async function run() {
  console.log(`\n=== DFOS v1 re-mint + prune (#1111) ===`);
  console.log(`mode: ${APPLY ? 'APPLY (will commit)' : 'DRY-RUN (no writes)'}`);

  // --- snapshot before ---
  const ours = await sql`SELECT did, dfos_did, log FROM auth.identity_chains`;
  const preV1 = ours.filter(r => didWidth(r.dfos_did) !== V1_WIDTH);
  console.log(
    `\nour identity chains: ${ours.length} total, ${preV1.length} pre-v1 (need re-mint)`,
  );

  // --- derive new dids from genesis (read-only, fail fast) ---
  const remints = [];
  for (const row of preV1) {
    const log = Array.isArray(row.log) ? row.log : JSON.parse(row.log);
    let verified;
    try {
      verified = await verifyIdentityChain({ didPrefix: DFOS_DID_PREFIX, log });
    } catch (err) {
      throw new Error(
        `verifyIdentityChain failed for ${row.dfos_did} (imajin ${row.did}): ${err?.message ?? err}`,
      );
    }
    const newDid = verified.did;
    if (didWidth(newDid) !== V1_WIDTH) {
      throw new Error(
        `re-derived did is not v1 width (${didWidth(newDid)}): ${newDid} — is the protocol lib v1 (idLength=31)?`,
      );
    }
    if (newDid === row.dfos_did) {
      throw new Error(`re-derived did unchanged for ${row.dfos_did} — expected widening`);
    }
    remints.push({ imajinDid: row.did, oldDid: row.dfos_did, newDid });
  }

  console.log(`\n--- re-mint plan (${remints.length}) ---`);
  for (const r of remints) {
    console.log(`  ${r.oldDid}  ->  ${r.newDid}   [${r.imajinDid}]`);
  }

  // collision guard: a new 31-char did must not already exist as someone else's chain
  for (const r of remints) {
    const clash = await sql`
      SELECT did FROM auth.identity_chains WHERE dfos_did = ${r.newDid} AND did <> ${r.imajinDid}
    `;
    if (clash.length) {
      throw new Error(`collision: ${r.newDid} already bound to ${clash[0].did}`);
    }
  }

  // --- prune preview: foreign rows (not bound to ANY of our chains) ---
  const ownDids = ours.map(r => r.dfos_did);
  // after re-mint the relay rows still carry OLD dids, so "ours" in relay = old + new
  const ownDidsAll = [...new Set([...ownDids, ...remints.map(r => r.newDid)])];

  const pruneCounts = await sql`
    SELECT
      (SELECT count(*) FROM relay.relay_identity_chains   r WHERE r.did      <> ALL(${ownDidsAll})) AS identity_chains,
      (SELECT count(*) FROM relay.relay_operations        o WHERE o.chain_id <> ALL(${ownDidsAll})) AS operations,
      (SELECT count(*) FROM relay.relay_operation_log     l WHERE l.chain_id <> ALL(${ownDidsAll})) AS operation_log,
      (SELECT count(*) FROM relay.relay_beacons           b WHERE b.did      <> ALL(${ownDidsAll})) AS beacons,
      (SELECT count(*) FROM relay.relay_content_chains)                                              AS content_chains_all,
      (SELECT count(*) FROM relay.relay_countersignatures)                                           AS countersignatures_all,
      (SELECT count(*) FROM relay.relay_documents)                                                   AS documents_all,
      (SELECT count(*) FROM relay.relay_revocations)                                                 AS revocations_all,
      (SELECT count(*) FROM relay.relay_public_credentials)                                          AS public_credentials_all,
      (SELECT count(*) FROM relay.relay_blobs)                                                        AS blobs_all,
      (SELECT count(*) FROM relay.relay_pending_operations)                                          AS pending_ops_all
  `;
  const pc = pruneCounts[0];
  console.log(`\n--- prune plan (foreign gossip; not bound to our chains) ---`);
  console.log(`  relay_identity_chains : ${pc.identity_chains}`);
  console.log(`  relay_operations      : ${pc.operations}`);
  console.log(`  relay_operation_log   : ${pc.operation_log}`);
  console.log(`  relay_beacons         : ${pc.beacons}`);
  console.log(`  content_chains  (ALL) : ${pc.content_chains_all}   (no Imajin-user binding; pruned whole)`);
  console.log(`  countersignatures(ALL): ${pc.countersignatures_all}`);
  console.log(`  documents       (ALL) : ${pc.documents_all}`);
  console.log(`  revocations     (ALL) : ${pc.revocations_all}`);
  console.log(`  public_creds    (ALL) : ${pc.public_credentials_all}`);
  console.log(`  blobs           (ALL) : ${pc.blobs_all}`);
  console.log(`  pending_ops     (ALL) : ${pc.pending_ops_all}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN complete. Re-run with --apply to commit.\n`);
    await sql.end();
    return;
  }

  // --- APPLY in one transaction ---
  await sql.begin(async tx => {
    // 1) PRUNE foreign. Content/countersign/document/blob/credential/revocation/
    //    pending corpora are entirely Brandon's gossip (no Imajin-user binding) —
    //    truncate wholesale. Identity/operation/log/beacon prune by NOT-ours.
    await tx`DELETE FROM relay.relay_identity_chains  WHERE did      <> ALL(${ownDidsAll})`;
    await tx`DELETE FROM relay.relay_operations       WHERE chain_id <> ALL(${ownDidsAll})`;
    await tx`DELETE FROM relay.relay_operation_log    WHERE chain_id <> ALL(${ownDidsAll})`;
    await tx`DELETE FROM relay.relay_beacons          WHERE did      <> ALL(${ownDidsAll})`;
    await tx`DELETE FROM relay.relay_content_chains`;
    await tx`DELETE FROM relay.relay_countersignatures`;
    await tx`DELETE FROM relay.relay_documents`;
    await tx`DELETE FROM relay.relay_revocations`;
    await tx`DELETE FROM relay.relay_public_credentials`;
    await tx`DELETE FROM relay.relay_blobs`;
    await tx`DELETE FROM relay.relay_pending_operations`;
    await tx`DELETE FROM relay.relay_peer_cursors`;

    // 2) RE-MINT: rewrite old -> new did across all references.
    for (const r of remints) {
      await tx`UPDATE auth.identity_chains          SET dfos_did = ${r.newDid} WHERE did = ${r.imajinDid}`;
      await tx`UPDATE relay.relay_identity_chains   SET did      = ${r.newDid} WHERE did      = ${r.oldDid}`;
      await tx`UPDATE relay.relay_operations        SET chain_id = ${r.newDid} WHERE chain_id = ${r.oldDid}`;
      await tx`UPDATE relay.relay_operation_log     SET chain_id = ${r.newDid} WHERE chain_id = ${r.oldDid}`;
      await tx`UPDATE relay.relay_beacons           SET did      = ${r.newDid} WHERE did      = ${r.oldDid}`;
      await tx`UPDATE registry.nodes                SET chain_did= ${r.newDid} WHERE chain_did= ${r.oldDid}`;
    }
  });

  // --- verify after ---
  const after = await sql`
    SELECT length(split_part(dfos_did,':',3)) AS w, count(*)::int AS n
    FROM auth.identity_chains GROUP BY 1 ORDER BY 1
  `;
  console.log(`\n--- after: auth.identity_chains width distribution ---`);
  for (const row of after) console.log(`  width ${row.w}: ${row.n}`);
  const stillPre = after.find(r => r.w !== V1_WIDTH);
  if (stillPre) {
    console.error(`\n❌ ${stillPre.n} chain(s) still at width ${stillPre.w} — investigate.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ All identity chains are v1 (${V1_WIDTH}-char). Re-mint + prune complete.\n`);
  }

  await sql.end();
}

run().catch(async err => {
  console.error('❌ FAILED:', err?.message ?? err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
