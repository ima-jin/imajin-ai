#!/usr/bin/env tsx
/**
 * Retroactive MJN emission backfill (#643)
 *
 * Credits MJN to existing identities based on their current tier:
 *   soft        → 10 MJN  (identity.created)
 *   preliminary → 110 MJN (identity.created + identity.verified.preliminary)
 *   established → 210 MJN (identity.created + identity.verified.preliminary + identity.verified.hard)
 *
 * Usage:
 *   cd apps/kernel
 *   npx tsx ../../scripts/backfill-emissions.ts --dry-run    # preview
 *   npx tsx ../../scripts/backfill-emissions.ts              # execute
 *
 * Idempotent: skips identities that already have emission transactions.
 * Run from apps/kernel/ so DB connection resolves from .env.local.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import postgres from 'postgres';

// Load .env.local manually (no dotenv dependency needed)
try {
  const envPath = resolve(process.cwd(), '.env.local');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env.local — rely on environment
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Run from apps/kernel/ directory.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const sql = postgres(DATABASE_URL);

interface Identity {
  id: string;
  tier: string;
  type: string;
}

const TIER_EMISSIONS: Record<string, { type: string; amount: number; reason: string }[]> = {
  soft: [
    { type: 'identity.created', amount: 10, reason: 'Welcome to the network' },
  ],
  preliminary: [
    { type: 'identity.created', amount: 10, reason: 'Welcome to the network' },
    { type: 'identity.verified.preliminary', amount: 100, reason: 'Preliminary verification' },
  ],
  established: [
    { type: 'identity.created', amount: 10, reason: 'Welcome to the network' },
    { type: 'identity.verified.preliminary', amount: 100, reason: 'Preliminary verification' },
    { type: 'identity.verified.hard', amount: 100, reason: 'Full identity verified' },
  ],
  hard: [
    { type: 'identity.created', amount: 10, reason: 'Welcome to the network' },
    { type: 'identity.verified.preliminary', amount: 100, reason: 'Preliminary verification' },
    { type: 'identity.verified.hard', amount: 100, reason: 'Full identity verified' },
  ],
};

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

async function main() {
  console.log(`\n🟠 MJN Emission Backfill${dryRun ? ' (DRY RUN)' : ''}\n`);

  // Get all identities
  const identities = await sql<Identity[]>`
    SELECT id, tier, type FROM auth.identities ORDER BY id
  `;
  console.log(`Found ${identities.length} identities\n`);

  // Get existing emission transactions to check idempotency
  const existingEmissions = await sql<{ to_did: string; metadata: Record<string, unknown> }[]>`
    SELECT to_did, metadata FROM pay.transactions
    WHERE type = 'emission' AND service = 'emissions'
  `;
  const emittedSet = new Set(
    existingEmissions.map(e => `${e.to_did}:${(e.metadata as Record<string, string>)?.attestation_type || ''}`)
  );

  let totalMjn = 0;
  let skipped = 0;
  let credited = 0;

  for (const identity of identities) {
    const tier = identity.tier || 'soft';
    const emissions = TIER_EMISSIONS[tier] || TIER_EMISSIONS.soft;

    for (const emission of emissions) {
      const key = `${identity.id}:${emission.type}`;
      if (emittedSet.has(key)) {
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY] ${identity.id.slice(0, 30)}... (${tier}) → +${emission.amount} MJN (${emission.reason})`);
        totalMjn += emission.amount;
        credited++;
        continue;
      }

      const txId = genId('tx');
      const attId = genId('att');

      try {
        // Upsert balance
        await sql`
          INSERT INTO pay.balances (did, credit_amount, cash_amount, currency)
          VALUES (${identity.id}, ${String(emission.amount)}, '0', 'MJN')
          ON CONFLICT (did) DO UPDATE SET
            credit_amount = (pay.balances.credit_amount::numeric + ${emission.amount})::text,
            updated_at = NOW()
        `;

        // Log transaction
        await sql`
          INSERT INTO pay.transactions (id, service, type, from_did, to_did, amount, currency, status, source, metadata, created_at)
          VALUES (
            ${txId}, 'emissions', 'emission', NULL, ${identity.id},
            ${String(emission.amount)}, 'MJN', 'completed', 'emission',
            ${JSON.stringify({
              attestation_id: attId,
              attestation_type: emission.type,
              reason: emission.reason,
              to_role: 'subject',
              backfill: true,
            })},
            NOW()
          )
        `;

        totalMjn += emission.amount;
        credited++;
        console.log(`  ✓ ${identity.id.slice(0, 30)}... (${tier}) → +${emission.amount} MJN (${emission.reason})`);
      } catch (err) {
        console.error(`  ✗ ${identity.id.slice(0, 30)}... FAILED:`, (err as Error).message);
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${dryRun ? 'Would credit' : 'Credited'}: ${totalMjn} MJN across ${credited} emissions`);
  console.log(`Skipped (already emitted): ${skipped}`);
  console.log(`Identities processed: ${identities.length}`);

  await sql.end();
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
