/**
 * POST /api/settle
 *
 * Execute a .fair multi-party settlement.
 * Validates from_did has sufficient balance, then atomically:
 * - Debit from_did (credits first, then cash)
 * - Credit each recipient in the fair_manifest chain (cash — real value earned)
 * - Log all transactions
 *
 * Request:
 * {
 *   from_did: string,
 *   total_amount: number,
 *   service: string,
 *   type: string,
 *   funded?: boolean,              // true = externally funded (e.g. Stripe), skip balance check/debit
 *   funded_provider?: string,      // "stripe", "solana", etc. — logged for audit
 *   fair_manifest: {
 *     chain: Array<{ did: string, amount: number, role: string }>
 *   },
 *   metadata?: Record<string, any>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, balances, transactions, identities, identityChains } from '@/src/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { verifyManifest } from '@imajin/fair';
import type { FairManifest, FairManifestV1_1 } from '@imajin/fair';
import { createDbResolver } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { verifyIntroAttributionManifestForSettlement } from '@/src/lib/fair/intro-attribution';

const log = createLogger('kernel');

async function verifyChainStatus(did: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ did: identityChains.did })
      .from(identityChains)
      .where(eq(identityChains.did, did))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

interface FairManifestChainItem {
  did: string;
  amount: number;
  role: string;
}

type SettlementValidationResult =
  | { error: string; status: number }
  | { signatureVerified: boolean };

function validateChain(chain: unknown, total_amount: number): { error: string; status: number } | { chainTotal: number } {
  if (!chain || !Array.isArray(chain)) {
    return { error: 'fair_manifest.chain must be an array', status: 400 };
  }
  let chainTotal = 0;
  for (const item of chain as FairManifestChainItem[]) {
    if (!item.did || !item.amount || !item.role) {
      return { error: 'Each chain item must have did, amount, and role', status: 400 };
    }
    chainTotal += item.amount;
  }
  if (Math.abs(chainTotal - total_amount) > 0.01) {
    return { error: `Chain total (${chainTotal}) does not match total_amount (${total_amount})`, status: 400 };
  }
  return { chainTotal };
}

/**
 * Verify a fair_manifest's optional Ed25519 signature for non-funded
 * settlements. Funded (external/Stripe) settlements skip verification —
 * the manifest came from our own service. `fair_manifest` is unvalidated
 * JSON from the request body — typed `Record<string, unknown>` here (never
 * `any`) and cast at the one call site that needs the full `FairManifest`
 * shape, same looseness the route has always had.
 */
async function verifySettlementSignature(params: {
  fair_manifest: Record<string, unknown>;
  from_did: string;
  service: string;
}): Promise<{ error: string; status: number } | { signatureVerified: boolean }> {
  const { fair_manifest, from_did, service } = params;
  if (fair_manifest.signature === undefined) {
    // Unsigned manifest — allow but warn (transitional period)
    log.warn({ fromDid: from_did, service }, 'Settlement received unsigned fair_manifest');
    return { signatureVerified: false };
  }
  const resolver = createDbResolver(db, identities);
  const wrappedResolver = async (did: string): Promise<string> => {
    const identity = await resolver(did);
    if (!identity) throw new Error(`Could not resolve public key for DID: ${did}`);
    return identity.publicKey;
  };
  const result = await verifyManifest(fair_manifest as unknown as FairManifest, wrappedResolver);
  if (!result.valid) {
    return { error: `fair_manifest signature verification failed: ${result.error}`, status: 400 };
  }
  return { signatureVerified: true };
}

/**
 * Pre-mutation validation for POST /api/settle: chain shape/sum, the #1886
 * intro-attribution money-rule guard, and (for non-funded settlements)
 * signature verification. Extracted so this function — not `POST` itself
 * — absorbs the branching these checks require; behavior is identical to
 * having them inline.
 */
async function validateSettlementRequest(params: {
  fair_manifest: Record<string, unknown>;
  total_amount: number;
  from_did: string;
  service: string;
  funded: boolean;
}): Promise<SettlementValidationResult> {
  const { fair_manifest, total_amount, from_did, service, funded } = params;

  const chainCheck = validateChain(fair_manifest.chain, total_amount);
  if ('error' in chainCheck) return chainCheck;

  // #1886 money-rule guard: a no-op for every manifest that isn't the
  // intro-attribution template. For that template, resolves
  // fair_manifest.provenance[] against real auth.attestations rows and
  // enforces the shared trigger gate (money points at facts; a dangling
  // ref, a missing intro_made anchor, an uncountersigned value_realized
  // claim, or an expired attribution window all refuse the settlement
  // outright, before any balance is touched).
  const introAttributionCheck = await verifyIntroAttributionManifestForSettlement(
    fair_manifest as unknown as Partial<FairManifestV1_1>,
  );
  if (!introAttributionCheck.ok) {
    return { error: introAttributionCheck.error, status: 400 };
  }

  if (funded) return { signatureVerified: false };
  return verifySettlementSignature({ fair_manifest, from_did, service });
}

interface SettlementSource {
  source: 'credit' | 'fiat' | 'mixed' | 'external';
  creditBurn: number;
  cashBurn: number;
  settleCurrency: string;
}

function sourceFromBurn(creditBurn: number, cashBurn: number): 'credit' | 'fiat' | 'mixed' {
  if (cashBurn === 0) return 'credit';
  if (creditBurn === 0) return 'fiat';
  return 'mixed';
}

/**
 * Resolve how a non-funded settlement is paid for (credit balance, cash
 * balance, or a mix), and how much of each to debit. Externally funded
 * (e.g. Stripe) settlements skip this entirely — no balance check, no
 * debit — and the caller never invokes this function for that case.
 */
async function resolveInternalSettlementSource(params: {
  from_did: string;
  total_amount: number;
  currency: string;
}): Promise<SettlementSource | { error: string; status: number }> {
  const { from_did, total_amount, currency } = params;
  const senderBalanceRows = await db.select().from(balances).where(eq(balances.did, from_did)).limit(1);

  const senderBalance = senderBalanceRows[0];
  const currentCash = senderBalance ? Number.parseFloat(senderBalance.cashAmount) : 0;
  const currentCredit = senderBalance ? Number.parseFloat(senderBalance.creditAmount) : 0;
  const totalBalance = currentCash + currentCredit;
  const settleCurrency = senderBalance?.currency || currency;

  if (totalBalance < total_amount) {
    return { error: `Insufficient balance: ${totalBalance} < ${total_amount}`, status: 400 };
  }

  const creditBurn = Math.min(currentCredit, total_amount);
  const cashBurn = total_amount - creditBurn;

  return { source: sourceFromBurn(creditBurn, cashBurn), creditBurn, cashBurn, settleCurrency };
}

async function emitAttestations(
  from_did: string,
  fair_manifest: { chain: Array<{ did: string; amount: number; role: string }> },
  batchId: string,
  txIds: string[],
  total_amount: number,
  source: string,
  payerChainVerified: boolean,
  payeeChainVerified: boolean,
) {
  const attestationCalls: Promise<void>[] = [];

  // One "customer" attestation per recipient
  for (const recipient of fair_manifest.chain) {
    attestationCalls.push(
      publish('customer', {
        issuer: recipient.did,
        subject: from_did,
        scope: 'pay',
        payload: { role: recipient.role, context_id: batchId, context_type: 'service' },
      }).catch((err) => {
        log.error({ err: String(err), did: recipient.did }, `Attestation (customer) error for ${recipient.did}`);
      })
    );
  }

  // One "transaction.settled" attestation from the platform
  const platformDid = process.env.PLATFORM_DID;
  if (platformDid) {
    attestationCalls.push(
      publish('transaction.settled', {
        issuer: platformDid,
        subject: from_did,
        scope: 'pay',
        payload: { total_amount, recipients: fair_manifest.chain.length, source, payerChainVerified, payeeChainVerified, context_id: batchId, context_type: 'service' },
      }).catch((err) => {
        log.error({ err: String(err) }, 'Attestation (transaction.settled) error');
      })
    );
  } else {
    log.warn({}, 'Attestation (transaction.settled) skipped: PLATFORM_DID not set');
  }

  await Promise.all(attestationCalls);

  // Mark transactions as credential_issued
  if (txIds.length > 0) {
    await db
      .update(transactions)
      .set({ credentialIssued: true })
      .where(inArray(transactions.id, txIds))
      .catch((err) => {
        log.error({ err: String(err) }, 'Failed to mark credential_issued on transactions');
      });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    // Service-to-service auth via API key
    const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
    const expectedKey = process.env.PAY_SERVICE_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid API key' },
        { status: 401, headers: cors }
      );
    }

    const body = await request.json();
    const { from_did, total_amount, service, type, fair_manifest, funded = false, funded_provider, metadata = {}, currency = 'CAD' } = body;

    if (!from_did || !total_amount || !service || !type || !fair_manifest) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, total_amount, service, type, fair_manifest' },
        { status: 400, headers: cors }
      );
    }

    const validation = await validateSettlementRequest({ fair_manifest, total_amount, from_did, service, funded });
    if ('error' in validation) {
      return NextResponse.json({ error: validation.error }, { status: validation.status, headers: cors });
    }
    const { signatureVerified } = validation;

    // Externally funded (e.g. Stripe checkout) skips balance check/debit
    // entirely; an internal settlement resolves which balance(s) to burn.
    const sourceResolution: SettlementSource | { error: string; status: number } = funded
      ? { source: 'external', creditBurn: 0, cashBurn: 0, settleCurrency: currency }
      : await resolveInternalSettlementSource({ from_did, total_amount, currency });
    if ('error' in sourceResolution) {
      return NextResponse.json({ error: sourceResolution.error }, { status: sourceResolution.status, headers: cors });
    }
    const { source, creditBurn, cashBurn, settleCurrency } = sourceResolution;

    // Verify chain status for payer and all payees (non-blocking — don't fail payment)
    const payeeDids = [...new Set((fair_manifest.chain as Array<{ did: string; amount: number; role: string }>).map((r) => r.did))];
    const [payerChainVerified, ...payeeVerifications] = await Promise.all([
      verifyChainStatus(from_did),
      ...payeeDids.map((did) => verifyChainStatus(did)),
    ]);
    const payeeChainVerified = payeeVerifications.every(Boolean);

    const batchId = generateId('batch');
    const txIds: string[] = [];

    // Atomic settlement
    await db.transaction(async (tx) => {
      // Debit from_did (skip for externally funded)
      if (!funded) {
        await tx
          .update(balances)
          .set({
            creditAmount: sql`${balances.creditAmount} - ${creditBurn}`,
            cashAmount: sql`${balances.cashAmount} - ${cashBurn}`,
            updatedAt: new Date(),
          })
          .where(eq(balances.did, from_did));
      }

      // Credit each recipient (earnings go to cash — real value created)
      // For externally-funded payments (Stripe), the seller already received money
      // via Stripe Connect. Only credit platform/node/buyer_credit balances — NOT the seller.
      const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

      for (const recipient of fair_manifest.chain) {
        const txId = generateId('tx');
        txIds.push(txId);

        const skipBalanceCredit = funded && SELLER_ROLES.has(recipient.role);

        // Insert transaction (always — for audit trail)
        await tx.insert(transactions).values({
          id: txId,
          service,
          type,
          fromDid: from_did,
          toDid: recipient.did,
          amount: recipient.amount.toString(),
          currency: settleCurrency,
          status: 'completed',
          source,
          fairManifest: fair_manifest,
          batchId,
          metadata: {
            ...metadata,
            role: recipient.role,
            ...(funded && { funded: true, funded_provider: funded_provider || 'unknown' }),
            signature_verified: funded ? false : signatureVerified,
            ...(skipBalanceCredit && { balance_skipped: true, reason: 'externally_funded_seller' }),
          },
        });

        // Credit recipient cash balance — skip for sellers on funded payments
        // (money already went to their Stripe Connected account)
        if (!skipBalanceCredit) {
          await tx
            .insert(balances)
            .values({
              did: recipient.did,
              cashAmount: recipient.amount.toString(),
              creditAmount: '0',
              currency: settleCurrency,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: balances.did,
              set: {
                cashAmount: sql`${balances.cashAmount} + ${recipient.amount}`,
                updatedAt: new Date(),
              },
            });
        }
      }
    });

    // Fire attestations asynchronously — don't block settlement response
    emitAttestations(from_did, fair_manifest, batchId, txIds, total_amount, source, payerChainVerified, payeeChainVerified).catch((err) => {
      log.error({ err: String(err) }, 'Attestation emission error');
    });

    return NextResponse.json(
      {
        settled: true,
        batchId,
        transactions: txIds,
        total_amount,
        recipients: fair_manifest.chain.length,
        source,
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Settlement error');
    return NextResponse.json(
      { error: 'Settlement failed' },
      { status: 500, headers: cors }
    );
  }
}
