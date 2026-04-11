#!/usr/bin/env node
/**
 * Recompute all balances from the transaction ledger.
 * 
 * The pay.balances table is a cache — pay.transactions is the source of truth.
 * This script replays all transactions and rebuilds balances from scratch.
 *
 * Rules:
 * - Emissions (type=emission, source=emission): credit to to_did's credit_amount (MJN)
 * - External funded seller credits (source=external, role=seller/creator/event):
 *   SKIP — money went to Stripe Connect, not platform balance
 * - All other credits (to_did): add to cash_amount
 * - Debits (from_did, source != external): subtract (credits first, then cash)
 * - Refunds (type=refund): reverse the original credit
 * - Checkout (type=checkout): platform record only, no balance effect
 *
 * Usage:
 *   node scripts/recompute-balances.mjs              # dry run
 *   node scripts/recompute-balances.mjs --apply      # update balances table
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');

// Load DATABASE_URL
const envPaths = [
  resolve(baseDir, 'apps/kernel/.env.local'),
  resolve(baseDir, 'apps/events/.env.local'),
];

let databaseUrl;
for (const p of envPaths) {
  try {
    const content = readFileSync(p, 'utf-8');
    const match = content.match(/^DATABASE_URL=["']?(.+?)["']?\s*$/m);
    if (match?.[1]) { databaseUrl = match[1]; break; }
  } catch { /* skip */ }
}
databaseUrl = databaseUrl || process.env.DATABASE_URL;
if (!databaseUrl) { console.error('❌ No DATABASE_URL'); process.exit(1); }

const postgres = (await import('postgres')).default;
const sql = postgres(databaseUrl, { max: 1 });

const SELLER_ROLES = new Set(['seller', 'creator', 'event']);
const PROTOCOL_DID = 'did:imajin:c6e6c109db4a1cc52995c0836f73cc6833d7e4624bc86e048118d72820873213';

try {
  console.log(`${dryRun ? '🔍 DRY RUN' : '🔥 APPLYING'} — recompute balances from ledger\n`);

  // Fetch ALL transactions
  const txns = await sql`
    SELECT id, type, source, from_did, to_did, amount::float as amount, 
           status, metadata, created_at
    FROM pay.transactions
    WHERE status = 'completed'
    ORDER BY created_at ASC
  `;

  console.log(`Processing ${txns.length} transactions...\n`);

  // Accumulate balances: { did: { cash: number, credit: number } }
  const balances = {};

  function ensure(did) {
    if (!balances[did]) balances[did] = { cash: 0, credit: 0 };
  }

  for (const tx of txns) {
    const role = tx.metadata?.role || null;
    const funded = tx.metadata?.funded === true || tx.source === 'external';

    // Skip checkout records — they're the Stripe session record, not a balance movement
    if (tx.type === 'checkout') continue;

    // Emissions go to credit_amount (MJN)
    if (tx.type === 'emission' || tx.source === 'emission') {
      if (tx.to_did) {
        ensure(tx.to_did);
        balances[tx.to_did].credit += tx.amount;
      }
      continue;
    }

    // Refunds — reverse the platform balance credits that were made on the original settlement.
    // The buyer gets refunded via Stripe (external), so no buyer balance movement.
    // Refund from_did is who originally received the credit and now gives it back.
    // But if the original credit was skipped (funded + seller role), the refund debit should also be skipped.
    if (tx.type === 'refund') {
      const refundRole = tx.metadata?.role || null;
      const wasSellerCredit = refundRole && SELLER_ROLES.has(refundRole);

      // Look up the original transaction to see if it was a funded seller credit
      // If no role on the refund, check if from_did matches a funded seller pattern
      // Simple heuristic: if from_did != platform DID and from_did != protocol DID, it's likely a seller reversal
      // More reliable: only debit from_did if they would have been credited in the first place
      
      // Platform/protocol always get credited, so always reverse those
      if (tx.from_did === 'platform' || tx.from_did === 'did:imajin:platform') {
        ensure('did:imajin:platform');
        balances['did:imajin:platform'].cash -= tx.amount;
      } else if (tx.from_did === PROTOCOL_DID) {
        ensure(PROTOCOL_DID);
        balances[PROTOCOL_DID].cash -= tx.amount;
      } else {
        // Non-platform from_did — this is reversing a seller/creator credit.
        // Since funded seller credits are skipped, the reversal should also be skipped.
        // (The money went through Stripe Connect, Stripe handles the refund too)
      }
      continue;
    }

    // External funded + seller role = skip balance credit (Stripe Connect handles it)
    if (funded && role && SELLER_ROLES.has(role)) {
      // Transaction exists for audit, but no balance movement
      continue;
    }

    // Tips paid via Stripe — seller gets money through Stripe Connect, not platform balance.
    // These show as source=fiat with no from_did (no internal balance debit).
    if (tx.type === 'tip' && !tx.from_did) {
      // Stripe-funded tip — skip platform balance credit
      continue;
    }

    // Credit to_did
    if (tx.to_did && tx.to_did !== 'platform') {
      ensure(tx.to_did);
      balances[tx.to_did].cash += tx.amount;
    } else if (tx.to_did === 'platform') {
      // Platform balance
      ensure('did:imajin:platform');
      balances['did:imajin:platform'].cash += tx.amount;
    }

    // Debit from_did (only for non-funded, non-emission transactions)
    if (tx.from_did && !funded && tx.source !== 'emission') {
      ensure(tx.from_did);
      // Debit credits first, then cash
      const debitAmount = tx.amount;
      const creditAvail = balances[tx.from_did].credit;
      const creditBurn = Math.min(creditAvail, debitAmount);
      const cashBurn = debitAmount - creditBurn;
      balances[tx.from_did].credit -= creditBurn;
      balances[tx.from_did].cash -= cashBurn;
    }
  }

  // Fetch current balances for comparison
  const currentBalances = await sql`SELECT did, cash_amount::float as cash, credit_amount::float as credit FROM pay.balances`;
  const currentMap = {};
  for (const b of currentBalances) {
    currentMap[b.did] = { cash: b.cash, credit: b.credit };
  }

  // Compare and report
  const allDids = new Set([...Object.keys(balances), ...Object.keys(currentMap)]);
  let diffs = 0;

  console.log('DID                                                              | Current Cash | Computed Cash | Current MJN | Computed MJN | Diff?');
  console.log('-'.repeat(130));

  for (const did of [...allDids].sort()) {
    const computed = balances[did] || { cash: 0, credit: 0 };
    const current = currentMap[did] || { cash: 0, credit: 0 };

    const cashDiff = Math.abs(computed.cash - current.cash) > 0.001;
    const creditDiff = Math.abs(computed.credit - current.credit) > 0.001;

    if (cashDiff || creditDiff) {
      const marker = '⚠️';
      console.log(
        `${did.padEnd(65)} | ${current.cash.toFixed(2).padStart(12)} | ${computed.cash.toFixed(2).padStart(13)} | ${current.credit.toFixed(2).padStart(11)} | ${computed.credit.toFixed(2).padStart(12)} | ${marker}`
      );
      diffs++;
    }
  }

  if (diffs === 0) {
    console.log('\n✅ All balances match the ledger. Nothing to fix.');
  } else {
    console.log(`\n⚠️  ${diffs} balance(s) differ from the ledger.`);

    if (!dryRun) {
      console.log('\nUpdating balances table...');
      for (const did of Object.keys(balances)) {
        const b = balances[did];
        await sql`
          INSERT INTO pay.balances (did, cash_amount, credit_amount, currency, updated_at)
          VALUES (${did}, ${b.cash.toFixed(8)}, ${b.credit.toFixed(8)}, 'USD', NOW())
          ON CONFLICT (did) DO UPDATE SET 
            cash_amount = ${b.cash.toFixed(8)},
            credit_amount = ${b.credit.toFixed(8)},
            updated_at = NOW()
        `;
      }
      console.log(`✅ Updated ${Object.keys(balances).length} balances.`);
    } else {
      console.log('Run with --apply to update.');
    }
  }

} catch (err) {
  console.error('❌ Error:', err);
  process.exit(1);
} finally {
  await sql.end();
}
