#!/usr/bin/env node
/**
 * Gift / event-topup unbacked-mint audit (#2018, feeds #2012 reconciliation)
 *
 * Context: before #2018, `/api/balance/gift` and `/api/balance/event-topup`
 * credited a recipient's MJNx (credit) balance with NO offsetting debit from
 * the issuing business — an unbacked mint by a non-kernel actor. The MJN
 * (cash) leg of both routes was always properly debited from the business,
 * so it is excluded here; only the MJNx leg is in scope.
 *
 * This script is READ-ONLY (no UPDATE/DELETE/INSERT, ever) and safe to run
 * against dev or prod: it sums `pay.transactions` rows for
 * `service IN ('gift','events')`, `type IN ('gift','event-topup')`,
 * `unit = 'MJNx'`. Every such row predating the #2018 fix represents MJNx
 * that was credited to a recipient with no matching debit anywhere in the
 * ledger — by construction of the old route code, not by inference.
 *
 * Run once against the target database to establish the historical
 * baseline for the #2012 reconciliation record, then paste the printed
 * summary into a comment on #2012. Safe to re-run after the fix deploys —
 * pass `--since <ISO date>` to scope to rows created before the deploy
 * cutover, so newly-issued (now correctly funded) rows aren't miscounted
 * as historical debt.
 *
 * Usage:
 *   node scripts/audit-gift-topup-mints.mjs
 *   node scripts/audit-gift-topup-mints.mjs --since 2026-09-14T00:00:00Z
 *   DATABASE_URL=... node scripts/audit-gift-topup-mints.mjs
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import envUtils from './env-utils.js';

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

const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : null;
if (since && Number.isNaN(Date.parse(since))) {
  console.error(`❌ --since value is not a valid date: ${since}`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

async function run() {
  console.log(`\n=== Gift / event-topup unbacked-mint audit (#2018 -> #2012) ===`);
  // Deliberately do NOT log the hostname (or any other part of
  // DATABASE_URL) — this script is meant to be safe to run against prod,
  // and its output may end up pasted into a public issue comment.
  console.log(`database: <connection configured via DATABASE_URL>`);
  if (since) console.log(`scope: rows created before ${since}`);

  const cutoverClause = since ? sql`AND created_at < ${since}` : sql``;

  // Per-route, per-unit totals for the two mint-shaped routes. The MJN leg
  // is included for context/contrast only (it was always debited); MJNx is
  // the actual unbacked-mint figure this audit exists to quantify.
  const byRouteUnit = await sql`
    SELECT
      service,
      type,
      unit,
      COUNT(*)::int AS row_count,
      COALESCE(SUM(amount::numeric), 0) AS total_amount,
      COUNT(DISTINCT from_did)::int AS distinct_issuers,
      COUNT(DISTINCT to_did)::int AS distinct_recipients
    FROM pay.transactions
    WHERE service IN ('gift', 'events')
      AND type IN ('gift', 'event-topup')
      AND unit IN ('MJN', 'MJNx')
      AND source_kind = 'transfer'
      ${cutoverClause}
    GROUP BY service, type, unit
    ORDER BY service, type, unit
  `;

  // Per-issuing-business breakdown of the unbacked MJNx leg only — this is
  // the number #2012's reconciliation needs to know "who owes what" if a
  // retroactive true-up is ever decided on (this script does not perform
  // one; it only measures).
  const perIssuerMjnx = await sql`
    SELECT
      from_did,
      service,
      type,
      COUNT(*)::int AS row_count,
      COALESCE(SUM(amount::numeric), 0) AS total_amount
    FROM pay.transactions
    WHERE service IN ('gift', 'events')
      AND type IN ('gift', 'event-topup')
      AND unit = 'MJNx'
      AND source_kind = 'transfer'
      ${cutoverClause}
    GROUP BY from_did, service, type
    ORDER BY total_amount DESC
    LIMIT 100
  `;

  const [totalUnbacked] = await sql`
    SELECT COALESCE(SUM(amount::numeric), 0) AS total
    FROM pay.transactions
    WHERE service IN ('gift', 'events')
      AND type IN ('gift', 'event-topup')
      AND unit = 'MJNx'
      AND source_kind = 'transfer'
      ${cutoverClause}
  `;

  console.log(`\n--- totals by route + unit ---`);
  for (const row of byRouteUnit) {
    const flag = row.unit === 'MJNx' ? '  <-- unbacked mint (no debit ever existed)' : '  (funded — MJN leg was always debited)';
    console.log(
      `  ${row.service}/${row.type} [${row.unit}]: ${row.row_count} rows, ${fmt(row.total_amount)} total, ` +
        `${row.distinct_issuers} issuer(s), ${row.distinct_recipients} recipient(s)${flag}`,
    );
  }

  console.log(`\n--- top issuing businesses by unbacked MJNx credited (top 100) ---`);
  if (perIssuerMjnx.length === 0) {
    console.log('  (none found)');
  }
  for (const row of perIssuerMjnx) {
    console.log(`  ${row.from_did ?? '(null from_did)'}  ${row.service}/${row.type}: ${fmt(row.total_amount)} MJNx (${row.row_count} rows)`);
  }

  console.log(`\n=== SUMMARY for #2012 reconciliation ===`);
  console.log(`Total historical MJNx credited via gift/event-topup with no matching debit: ${fmt(totalUnbacked.total)} MJNx`);
  console.log(`(This audit is read-only; no rows were modified. #2018 fixes the routes going forward — it does not retroactively true up these totals.)\n`);

  await sql.end();
}

try {
  await run();
} catch (err) {
  console.error('❌ FAILED:', err?.message ?? err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
}
