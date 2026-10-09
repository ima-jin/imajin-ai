/**
 * Registered-app settlement (#2642) — the logic behind `POST /pay/api/settle`.
 *
 * The route used to accept one shared `PAY_SERVICE_API_KEY` bearer from every
 * caller. It now speaks only the registered-app contract:
 *
 *   1. AUTH — an app-service token (`typ: app-service+jwt`, minted by
 *      `POST /auth/api/apps/token/service`) carrying the operator-approved
 *      `pay:settle` scope. The token is verified in-process (`verifyAppToken`),
 *      then — like `/auth/api/attestations` re-resolves every audience on every
 *      call (#1990/#2674) — the app is re-read from `registry.apps` so a revoked
 *      app, or a revoked `pay:settle` approval (#2711), stops settling at once
 *      instead of at token expiry.
 *   2. OWNERSHIP — the payment is a `pay.transactions` row an app-authenticated
 *      checkout bound to its DID. Another app's payment, an unbound payment
 *      (user/anonymous checkout, legacy row) and an unknown manifest are all
 *      refused (403); the caller never gets to name the payer, amount, rail or
 *      service — those come from the kernel's own record.
 *   3. VERIFICATION — the posted `fair_manifest` chain must equal the payee
 *      manifest recorded at checkout (see `payee-manifest.ts`).
 *   4. FUNDING — only a payment the rail has already confirmed
 *      (`status = 'completed'`) settles, always as an externally funded
 *      settlement: no app token can debit a user's internal balance.
 *   5. IDEMPOTENCY — the settled marker is claimed inside the settlement's own
 *      DB transaction (`settlePayment`'s `appBinding`), so a second settle of
 *      the same payment — even a concurrent one — returns the prior result and
 *      pays nothing twice.
 */
import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { decodeProtectedHeader } from 'jose';
import { createLogger } from '@imajin/logger';
import { db, registryApps, transactions } from '@/src/db';
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { STRIPE_BYO_RAIL } from './external-ref';
import { verifyAgainstPayeeManifest } from './payee-manifest';
import { settlePayment, type SettlePaymentResult } from './settle-core';

const log = createLogger('kernel');

/** The operator-approved per-app service scope that gates the app settle path. */
export const PAY_SETTLE_SCOPE = 'pay:settle';

/** JWT `typ` of a session-less app-service token — see `createAppServiceToken`. */
const APP_SERVICE_TOKEN_TYP = 'app-service+jwt';

/** Dollar tolerance when comparing a posted total against the recorded payment amount. */
const TOTAL_TOLERANCE = 0.01;

/** `from_did` recorded for a payment whose checkout carried no user identity. */
const ANONYMOUS_PAYER = 'anonymous';

type Failure = { error: string; status: number };
type TxRow = typeof transactions.$inferSelect;

export type SettleForAppResult =
  | Failure
  | {
      settled: true;
      batchId: string;
      transactions: string[];
      total_amount: number;
      recipients: number;
      source: string;
      /** True when this call replayed a settlement that had already happened. */
      alreadySettled?: true;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 1. Auth
// ---------------------------------------------------------------------------

/**
 * True when the request carries a Bearer token whose protected header declares
 * it an app-service token (`typ: app-service+jwt`). Cheap, unverified peek — it
 * only decides which auth path a caller is ATTEMPTING (so a checkout carrying a
 * session Bearer keeps using session auth); `authenticateSettleApp` is what
 * actually verifies the token.
 */
export function carriesAppServiceToken(request: Pick<NextRequest, 'headers'>): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  try {
    return decodeProtectedHeader(header.slice('Bearer '.length)).typ === APP_SERVICE_TOKEN_TYP;
  } catch {
    return false;
  }
}

/**
 * Authenticate the caller as a registered app holding an operator-approved
 * `pay:settle`. 401 = no/invalid credential (including the retired shared API
 * key, which is not a JWT); 403 = a real credential that may not settle.
 */
export async function authenticateSettleApp(request: NextRequest): Promise<{ appDid: string } | Failure> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return { error: 'Unauthorized - app-service token required', status: 401 };
  }

  const claims = await verifyAppToken(header.slice('Bearer '.length));
  if (!claims) {
    return { error: 'Unauthorized - invalid or expired app-service token', status: 401 };
  }
  // A user-delegated app token carries a user; settling is the app acting as itself.
  if (!claims.isServiceToken || !claims.azp) {
    return { error: 'Forbidden - an app-service token is required', status: 403 };
  }
  const scopes = claims.scope.split(' ').filter(Boolean);
  if (!scopes.includes(PAY_SETTLE_SCOPE)) {
    return { error: `Forbidden - scope '${PAY_SETTLE_SCOPE}' was not granted`, status: 403 };
  }

  const [app] = await db
    .select({ status: registryApps.status, approved: registryApps.approvedServiceScopes })
    .from(registryApps)
    .where(eq(registryApps.appDid, claims.azp))
    .limit(1);
  if (app?.status !== 'active') {
    return { error: 'Forbidden - app is not an active registered app', status: 403 };
  }
  if (!Array.isArray(app.approved) || !app.approved.includes(PAY_SETTLE_SCOPE)) {
    return { error: `Forbidden - '${PAY_SETTLE_SCOPE}' is not operator-approved for this app`, status: 403 };
  }

  return { appDid: claims.azp };
}

// ---------------------------------------------------------------------------
// 2-4. Ownership, verification, funding
// ---------------------------------------------------------------------------

/** Read the posted request body into the few fields the app path honours. */
function parseSettleBody(body: unknown):
  | { transactionId: string; fairManifest: { chain: unknown; taxCredits?: unknown }; totalAmount?: number; fromDid?: string; metadata: Record<string, unknown> }
  | Failure {
  if (!isRecord(body)) return { error: 'Invalid request body', status: 400 };
  const { transaction_id: transactionId, fair_manifest: fairManifest, total_amount: totalAmount, from_did: fromDid, metadata } = body;

  if (typeof transactionId !== 'string' || transactionId.length === 0 || !isRecord(fairManifest) || !Array.isArray(fairManifest.chain)) {
    return { error: 'Missing required fields: transaction_id, fair_manifest.chain', status: 400 };
  }
  if (totalAmount !== undefined && (typeof totalAmount !== 'number' || !Number.isFinite(totalAmount))) {
    return { error: 'total_amount must be a finite number when present', status: 400 };
  }
  if (fromDid !== undefined && typeof fromDid !== 'string') {
    return { error: 'from_did must be a string when present', status: 400 };
  }
  return {
    transactionId,
    fairManifest: { chain: fairManifest.chain, taxCredits: fairManifest.taxCredits },
    totalAmount: totalAmount as number | undefined,
    fromDid: fromDid as string | undefined,
    metadata: isRecord(metadata) ? metadata : {},
  };
}

/** The result of the settlement a payment already went through, rebuilt from its per-recipient rows. */
async function priorSettlement(row: TxRow): Promise<SettleForAppResult> {
  const rows = row.settleBatchId
    ? await db.select().from(transactions).where(eq(transactions.batchId, row.settleBatchId))
    : [];
  const recipientRows = rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.role !== 'tax');
  return {
    settled: true,
    batchId: row.settleBatchId ?? '',
    transactions: rows.map((r) => r.id),
    total_amount: Number.parseFloat(row.amount),
    recipients: recipientRows.length,
    source: rows[0]?.source ?? 'external',
    alreadySettled: true,
  };
}

/** Everything the kernel itself must be satisfied of before any money moves. */
function verifyPaymentForSettle(
  row: TxRow,
  parsed: { fairManifest: { chain: unknown; taxCredits?: unknown }; totalAmount?: number; fromDid?: string },
): Failure | { total: number; fromDid: string } {
  if (row.status !== 'completed') {
    return { error: `Payment is not paid yet (status '${row.status}')`, status: 409 };
  }
  // #2757: a charge on the seller's OWN Stripe account never touched the platform, so there is nothing to
  // distribute. Settling it would credit platform balances with money the platform does not hold.
  if (row.rail === STRIPE_BYO_RAIL) {
    return { error: "Payment was made on the seller's own Stripe account — there is nothing to settle on-platform", status: 409 };
  }

  const total = Number.parseFloat(row.amount);
  if (parsed.totalAmount !== undefined && Math.abs(parsed.totalAmount - total) > TOTAL_TOLERANCE) {
    return { error: `total_amount (${parsed.totalAmount}) does not match the recorded payment (${total})`, status: 403 };
  }

  const fromDid = row.fromDid ?? ANONYMOUS_PAYER;
  if (parsed.fromDid !== undefined && parsed.fromDid !== fromDid) {
    return { error: 'from_did does not match the recorded payer', status: 403 };
  }

  const mismatch = verifyAgainstPayeeManifest({ recorded: row.payeeManifest, posted: parsed.fairManifest, totalAmount: total });
  if (mismatch) {
    return { error: `fair_manifest does not match the recorded payee manifest: ${mismatch}`, status: 403 };
  }
  return { total, fromDid };
}

/** Carry only the audited fields of the (now verified) posted manifest into the ledger rows. */
function sanitizedManifest(posted: { chain: unknown; taxCredits?: unknown }) {
  const chain = (posted.chain as Array<{ did: string; amount: number; role: string }>).map(({ did, amount, role }) => ({ did, amount, role }));
  const taxCredits = Array.isArray(posted.taxCredits)
    ? (posted.taxCredits as Array<Record<string, unknown>>).map((c) => ({
        did: c.did as string,
        amount: c.amount as number,
        jurisdiction: c.jurisdiction as string,
        kind: c.kind as string,
        rateBps: c.rateBps as number,
        remitTo: c.remitTo as string,
        registrationNumber: c.registrationNumber as string,
      }))
    : undefined;
  return { chain, ...(taxCredits && { taxCredits }) };
}

async function loadPayment(transactionId: string): Promise<TxRow | undefined> {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  return row;
}

/**
 * Settle a payment on behalf of an authenticated registered app. `appDid` is
 * the verified token subject (`authenticateSettleApp`); `body` is the raw JSON.
 */
export async function settleForApp(appDid: string, body: unknown): Promise<SettleForAppResult> {
  const parsed = parseSettleBody(body);
  if ('error' in parsed) return parsed;

  const row = await loadPayment(parsed.transactionId);
  if (!row) return { error: 'Payment not found', status: 404 };
  // Another app's payment and an unbound payment (app_did NULL) fail the same check.
  if (row.appDid !== appDid) {
    log.warn({ appDid, transactionId: row.id, boundTo: row.appDid ?? null }, 'App tried to settle a payment it did not create');
    return { error: 'Forbidden - payment was not created by this app', status: 403 };
  }
  if (row.settledAt) return priorSettlement(row);

  const verified = verifyPaymentForSettle(row, parsed);
  if ('error' in verified) return verified;

  const result: SettlePaymentResult = await settlePayment({
    from_did: verified.fromDid,
    total_amount: verified.total,
    service: row.service,
    type: row.type,
    fair_manifest: sanitizedManifest(parsed.fairManifest),
    funded: true,
    funded_provider: row.rail ?? 'stripe',
    currency: row.currency,
    // Caller metadata first so the kernel's own binding fields always win.
    metadata: { ...parsed.metadata, payment_id: row.id, app_did: appDid },
    appBinding: { transactionId: row.id, appDid },
  });

  if ('error' in result) {
    if (result.alreadySettled) {
      // Lost a race with a concurrent settle of the same payment — replay its result.
      const settled = await loadPayment(row.id);
      if (settled?.settledAt) return priorSettlement(settled);
    }
    return { error: result.error, status: result.status };
  }
  return result;
}
