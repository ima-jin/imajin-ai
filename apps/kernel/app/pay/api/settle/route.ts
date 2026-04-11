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
import { createDbResolver, emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

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
      emitAttestation({
        issuer_did: recipient.did,
        subject_did: from_did,
        type: 'customer',
        context_id: batchId,
        context_type: 'service',
        payload: { role: recipient.role },
      }).catch((err) => {
        log.error({ err: String(err), did: recipient.did }, `Attestation (customer) error for ${recipient.did}`);
      })
    );
  }

  // One "transaction.settled" attestation from the platform
  const platformDid = process.env.PLATFORM_DID;
  if (platformDid) {
    attestationCalls.push(
      emitAttestation({
        issuer_did: platformDid,
        subject_did: from_did,
        type: 'transaction.settled',
        context_id: batchId,
        context_type: 'service',
        payload: { total_amount, recipients: fair_manifest.chain.length, source, payerChainVerified, payeeChainVerified },
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
    const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
    const expectedKey = process.env.PAY_SERVICE_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized - invalid API key' },
        { status: 401, headers: cors }
      );
    }

    const body = await request.json();
    const { from_did, total_amount, service, type, fair_manifest, funded = false, funded_provider, metadata = {} } = body;

    if (!from_did || !total_amount || !service || !type || !fair_manifest) {
      return NextResponse.json(
        { error: 'Missing required fields: from_did, total_amount, service, type, fair_manifest' },
        { status: 400, headers: cors }
      );
    }

    if (!fair_manifest.chain || !Array.isArray(fair_manifest.chain)) {
      return NextResponse.json(
        { error: 'fair_manifest.chain must be an array' },
        { status: 400, headers: cors }
      );
    }

    // Validate chain
    let chainTotal = 0;
    for (const item of fair_manifest.chain) {
      if (!item.did || !item.amount || !item.role) {
        return NextResponse.json(
          { error: 'Each chain item must have did, amount, and role' },
          { status: 400, headers: cors }
        );
      }
      chainTotal += item.amount;
    }

    // Verify total matches chain sum
    if (Math.abs(chainTotal - total_amount) > 0.01) {
      return NextResponse.json(
        { error: `Chain total (${chainTotal}) does not match total_amount (${total_amount})` },
        { status: 400, headers: cors }
      );
    }

    // Cryptographic signature verification for non-funded settlements.
    // Funded (external/Stripe) settlements skip verification — manifest came from our own service.
    let signatureVerified = false;

    if (!funded) {
      if (fair_manifest.signature !== undefined) {
        const resolver = createDbResolver(db, identities);
        const wrappedResolver = async (did: string): Promise<string> => {
          const identity = await resolver(did);
          if (!identity) throw new Error(`Could not resolve public key for DID: ${did}`);
          return identity.publicKey;
        };

        const result = await verifyManifest(fair_manifest, wrappedResolver);
        if (result.valid) {
          signatureVerified = true;
        } else {
          // Signed but invalid — reject
          return NextResponse.json(
            { error: `fair_manifest signature verification failed: ${result.error}` },
            { status: 400, headers: cors }
          );
        }
      } else {
        // Unsigned manifest — allow but warn (transitional period)
        log.warn({ fromDid: from_did, service }, 'Settlement received unsigned fair_manifest');
      }
    }

    let source: 'credit' | 'fiat' | 'mixed' | 'external';
    let creditBurn = 0;
    let cashBurn = 0;

    if (funded) {
      // Externally funded (e.g. Stripe checkout) — no balance check, no debit
      source = 'external';
    } else {
      // Internal balance settlement — check and debit
      const senderBalanceRows = await db
        .select()
        .from(balances)
        .where(eq(balances.did, from_did))
        .limit(1);

      const senderBalance = senderBalanceRows[0];
      const currentCash = senderBalance ? parseFloat(senderBalance.cashAmount) : 0;
      const currentCredit = senderBalance ? parseFloat(senderBalance.creditAmount) : 0;
      const totalBalance = currentCash + currentCredit;

      if (totalBalance < total_amount) {
        return NextResponse.json(
          { error: `Insufficient balance: ${totalBalance} < ${total_amount}` },
          { status: 400, headers: cors }
        );
      }

      creditBurn = Math.min(currentCredit, total_amount);
      cashBurn = total_amount - creditBurn;

      if (cashBurn === 0) {
        source = 'credit';
      } else if (creditBurn === 0) {
        source = 'fiat';
      } else {
        source = 'mixed';
      }
    }

    // Verify chain status for payer and all payees (non-blocking — don't fail payment)
    const payeeDids = [...new Set(fair_manifest.chain.map((r) => r.did))];
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
          currency: 'USD',
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
              currency: 'USD',
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
