#!/usr/bin/env npx tsx
/**
 * One-time migration: convert all did:email:* soft DIDs to stable did:imajin:xxx DIDs.
 *
 * For each did:email:* identity:
 *   1. Mint a new did:imajin:xxx DID
 *   2. Extract email from metadata->>'email' or decode from DID string
 *   3. Insert an auth.credentials row linking did:imajin:xxx → email
 *   4. Update auth.identities.id to the new DID
 *   5. Update every foreign DID reference across all schemas
 *   6. Record the mapping in profile.did_migrations
 *
 * All changes for a single identity are wrapped in a transaction.
 * Already-migrated DIDs (in profile.did_migrations) are skipped.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrate-stable-dids.ts
 *   DATABASE_URL=... npx tsx scripts/migrate-stable-dids.ts --dry-run
 *   npx tsx scripts/migrate-stable-dids.ts --database-url postgres://... --dry-run
 */

import postgres from 'postgres';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DB_URL_ARG = (() => {
  const idx = args.indexOf('--database-url');
  return idx !== -1 ? args[idx + 1] : undefined;
})();
const DATABASE_URL = DB_URL_ARG || process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required (--database-url or env var)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** URL-safe base62 alphabet (same length as nanoid's default) */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function secureId(length: number): string {
  const bytes = randomBytes(length * 2); // over-generate to allow rejection sampling
  let result = '';
  for (let i = 0; i < bytes.length && result.length < length; i++) {
    const byte = bytes[i];
    if (byte < ALPHABET.length * Math.floor(256 / ALPHABET.length)) {
      result += ALPHABET[byte % ALPHABET.length];
    }
  }
  // Fallback if we didn't get enough bytes (extremely rare)
  while (result.length < length) {
    result += ALPHABET[randomBytes(1)[0] % ALPHABET.length];
  }
  return result;
}

function decodeEmailFromOldDid(did: string): string | null {
  if (!did.startsWith('did:email:')) return null;
  // did:email:user_at_domain_com → user@domain.com
  // Note: this is lossy (dots in local part collapse), but best-effort fallback
  return did.slice('did:email:'.length).replace(/_at_/g, '@').replace(/_/g, '.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SoftIdentity {
  id: string; // did:email:xxx
  metadata: Record<string, unknown> | null;
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no writes\n' : '🚀 LIVE RUN — writing changes\n');

  const sql = postgres(DATABASE_URL!);

  try {
    // Find all unprocessed did:email:* identities
    const identities: SoftIdentity[] = await sql`
      SELECT id, metadata
      FROM auth.identities
      WHERE id LIKE 'did:email:%'
        AND id NOT IN (
          SELECT old_did FROM profile.did_migrations WHERE old_did LIKE 'did:email:%'
        )
      ORDER BY created_at
    `;

    if (identities.length === 0) {
      console.log('✅ No did:email:* identities to migrate.');
      await sql.end();
      return;
    }

    console.log(`Found ${identities.length} did:email:* identit${identities.length === 1 ? 'y' : 'ies'} to migrate.\n`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const ident of identities) {
      const oldDid = ident.id;

      // Extract email
      const email: string | null =
        (ident.metadata as any)?.email ||
        decodeEmailFromOldDid(oldDid);

      if (!email) {
        console.warn(`  ⚠️  ${oldDid} — cannot determine email, skipping`);
        skipped++;
        continue;
      }

      const newDid = `did:imajin:${secureId(16)}`;
      const credId = `cred_${secureId(16)}`;
      const migrationId = `migration_${secureId(16)}`;

      console.log(`  ${oldDid}`);
      console.log(`  → ${newDid} (email: ${email})`);

      if (DRY_RUN) {
        migrated++;
        continue;
      }

      try {
        await sql.begin(async (tx) => {
          // 1. Update auth.identities primary key
          await tx`UPDATE auth.identities SET id = ${newDid} WHERE id = ${oldDid}`;

          // 2. Insert email credential
          await tx`
            INSERT INTO auth.credentials (id, did, type, value, verified_at, created_at)
            VALUES (${credId}, ${newDid}, 'email', ${email.toLowerCase().trim()}, NOW(), NOW())
            ON CONFLICT (type, value) DO NOTHING
          `;

          // 3. Update auth foreign references
          await tx`UPDATE auth.attestations SET issuer_did = ${newDid} WHERE issuer_did = ${oldDid}`;
          await tx`UPDATE auth.attestations SET subject_did = ${newDid} WHERE subject_did = ${oldDid}`;
          await tx`UPDATE auth.tokens SET identity_id = ${newDid} WHERE identity_id = ${oldDid}`;
          await tx`UPDATE auth.challenges SET identity_id = ${newDid} WHERE identity_id = ${oldDid}`;

          // 4. Update events schema
          await tx`UPDATE events.tickets SET owner_did = ${newDid} WHERE owner_did = ${oldDid}`;
          await tx`UPDATE events.tickets SET original_owner_did = ${newDid} WHERE original_owner_did = ${oldDid}`;
          await tx`UPDATE events.tickets SET held_by = ${newDid} WHERE held_by = ${oldDid}`;
          await tx`UPDATE events.events SET creator_did = ${newDid} WHERE creator_did = ${oldDid}`;
          await tx`UPDATE events.event_admins SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE events.event_admins SET added_by = ${newDid} WHERE added_by = ${oldDid}`;
          await tx`UPDATE events.ticket_transfers SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE events.ticket_transfers SET to_did = ${newDid} WHERE to_did = ${oldDid}`;
          await tx`UPDATE events.ticket_queue SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE events.ticket_registrations SET registered_by_did = ${newDid} WHERE registered_by_did = ${oldDid}`;

          // 5. Update chat schema
          await tx`UPDATE chat.conversations SET created_by = ${newDid} WHERE created_by = ${oldDid}`;
          await tx`UPDATE chat.participants SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE chat.participants SET invited_by = ${newDid} WHERE invited_by = ${oldDid}`;
          await tx`UPDATE chat.messages SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE chat.invites SET created_by = ${newDid} WHERE created_by = ${oldDid}`;
          await tx`UPDATE chat.invites SET for_did = ${newDid} WHERE for_did = ${oldDid}`;
          await tx`UPDATE chat.public_keys SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE chat.pre_keys SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE chat.read_receipts SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE chat.conversation_reads SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE chat.message_reactions SET did = ${newDid} WHERE did = ${oldDid}`;

          // 6. Update connections schema
          await tx`UPDATE connections.pods SET owner_did = ${newDid} WHERE owner_did = ${oldDid}`;
          await tx`UPDATE connections.pod_members SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE connections.pod_members SET added_by = ${newDid} WHERE added_by = ${oldDid}`;
          await tx`UPDATE connections.pod_member_keys SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE connections.invites SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE connections.invites SET to_did = ${newDid} WHERE to_did = ${oldDid}`;
          await tx`UPDATE connections.invites SET consumed_by = ${newDid} WHERE consumed_by = ${oldDid}`;

          // 7. Update learn schema
          await tx`UPDATE learn.courses SET creator_did = ${newDid} WHERE creator_did = ${oldDid}`;
          await tx`UPDATE learn.enrollments SET student_did = ${newDid} WHERE student_did = ${oldDid}`;

          // 8. Update coffee schema
          await tx`UPDATE coffee.pages SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE coffee.tips SET from_did = ${newDid} WHERE from_did = ${oldDid}`;

          // 9. Update dykil schema
          await tx`UPDATE dykil.surveys SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE dykil.survey_responses SET respondent_did = ${newDid} WHERE respondent_did = ${oldDid}`;

          // 10. Update media schema
          await tx`UPDATE media.assets SET owner_did = ${newDid} WHERE owner_did = ${oldDid}`;
          await tx`UPDATE media.folders SET owner_did = ${newDid} WHERE owner_did = ${oldDid}`;

          // 11. Update input schema
          await tx`UPDATE input.jobs SET requester_did = ${newDid} WHERE requester_did = ${oldDid}`;

          // 12. Update pay schema
          await tx`UPDATE pay.transactions SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE pay.transactions SET to_did = ${newDid} WHERE to_did = ${oldDid}`;
          await tx`UPDATE pay.balances SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE pay.balance_rollups SET did = ${newDid} WHERE did = ${oldDid}`;
          await tx`UPDATE pay.connected_accounts SET did = ${newDid} WHERE did = ${oldDid}`;

          // 13. Update links schema
          await tx`UPDATE links.pages SET did = ${newDid} WHERE did = ${oldDid}`;

          // 14. Update profile schema (did is primary key — update dependents first)
          await tx`UPDATE profile.connections SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE profile.connections SET to_did = ${newDid} WHERE to_did = ${oldDid}`;
          await tx`UPDATE profile.connection_requests SET from_did = ${newDid} WHERE from_did = ${oldDid}`;
          await tx`UPDATE profile.connection_requests SET to_did = ${newDid} WHERE to_did = ${oldDid}`;
          await tx`UPDATE profile.follows SET follower_did = ${newDid} WHERE follower_did = ${oldDid}`;
          await tx`UPDATE profile.follows SET followed_did = ${newDid} WHERE followed_did = ${oldDid}`;
          await tx`UPDATE profile.query_logs SET requester_did = ${newDid} WHERE requester_did = ${oldDid}`;
          await tx`UPDATE profile.query_logs SET target_did = ${newDid} WHERE target_did = ${oldDid}`;
          await tx`UPDATE profile.profiles SET did = ${newDid} WHERE did = ${oldDid}`;

          // 15. Update www schema
          await tx`UPDATE www.bug_reports SET reporter_did = ${newDid} WHERE reporter_did = ${oldDid}`;
          await tx`UPDATE www.bug_reports SET reviewed_by = ${newDid} WHERE reviewed_by = ${oldDid}`;

          // 16. Record migration
          await tx`
            INSERT INTO profile.did_migrations (id, old_did, new_did, migrated_at)
            VALUES (${migrationId}, ${oldDid}, ${newDid}, NOW())
          `;
        });

        console.log(`     ✅ done\n`);
        migrated++;
      } catch (err) {
        console.error(`     ❌ failed:`, err);
        failed++;
      }
    }

    console.log('─'.repeat(50));
    console.log(`Migrated:  ${migrated}`);
    console.log(`Skipped:   ${skipped}`);
    console.log(`Failed:    ${failed}`);
    if (DRY_RUN) {
      console.log('\n(Dry run — no changes written)');
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
