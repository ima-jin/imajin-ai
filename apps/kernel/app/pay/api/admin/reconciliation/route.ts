/**
 * GET /pay/api/admin/reconciliation
 *
 * #2016 decision 4 — the ledger must always be able to say, for any
 * balance, how much is backed (MJN) and how much is emitted (MJNx).
 * Adapted directly from the #2012 audit comment's §6 SQL sketch to the new
 * row-per-(did, unit) `pay.balances` shape and the new `unit`/`source_kind`
 * columns on `pay.transactions`.
 *
 * Single-node only: per #738 Decision 2 ("there are no other nodes — it is
 * theory"), this does not attempt a per-node breakdown; every row here is
 * implicitly this node's.
 *
 * Auth: requireAdmin (actingAs === NODE_DID).
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Circulating MJNx: everything currently sitting in an MJNx balance row.
  const [circulating] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS circulating_mjnx
    FROM pay.balances
    WHERE unit = 'MJNx'
  `;

  // Backed MJN: everything currently sitting in an MJN balance row — this
  // is the ledger's withdrawable liability, which must always be coverable
  // by the fiat reserve behind it.
  const [backed] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS backed_mjn
    FROM pay.balances
    WHERE unit = 'MJN'
  `;

  // Lifetime emitted (MJNx minted via source_kind='emission') vs lifetime
  // receipted (MJN minted via source_kind='receipt', type='topup') per DID,
  // alongside each DID's current outstanding balance in each unit.
  const perDid = await sql`
    WITH emitted AS (
      SELECT to_did AS did, SUM(amount::numeric) AS lifetime_emitted
      FROM pay.transactions
      WHERE unit = 'MJNx' AND source_kind = 'emission'
      GROUP BY to_did
    ),
    receipted AS (
      SELECT to_did AS did, SUM(amount::numeric) AS lifetime_receipted
      FROM pay.transactions
      WHERE unit = 'MJN' AND source_kind = 'receipt' AND type = 'topup'
      GROUP BY to_did
    )
    SELECT
      b.did,
      MAX(b.currency) FILTER (WHERE b.unit = 'MJN') AS currency,
      COALESCE(MAX(b.amount) FILTER (WHERE b.unit = 'MJN'), 0) AS mjn_amount,
      COALESCE(MAX(b.amount) FILTER (WHERE b.unit = 'MJNx'), 0) AS mjnx_amount,
      COALESCE(MAX(e.lifetime_emitted), 0) AS lifetime_emitted,
      COALESCE(MAX(r.lifetime_receipted), 0) AS lifetime_receipted
    FROM pay.balances b
    LEFT JOIN emitted e ON e.did = b.did
    LEFT JOIN receipted r ON r.did = b.did
    GROUP BY b.did
    ORDER BY mjnx_amount DESC
    LIMIT 500
  `;

  return NextResponse.json({
    circulatingMjnx: circulating.circulating_mjnx,
    backedMjn: backed.backed_mjn,
    // #738 Decision 2: single node today — this is that node's own totals,
    // not a cross-node breakdown.
    perDid,
  });
}
