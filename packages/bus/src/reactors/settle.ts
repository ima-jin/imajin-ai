import { createLogger } from '@imajin/logger';
import { publish } from '../publish';
import type { ReactorHandler } from '../types';
import { computeFeeCents, resolveSettlementChain } from '@imajin/fair';

const log = createLogger('bus:settle');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

interface FairEntry {
  did: string;
  role: string;
  share: number;
}

interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  fixedCents: number;
}

interface FairManifest {
  version?: string;
  fees?: FairFee[];
  chain?: FairEntry[];
  distributions?: FairEntry[];
  [key: string]: unknown;
}

export const settleReactor: ReactorHandler = async (event, _config) => {
  if (!PAY_SERVICE_URL || !PAY_SERVICE_API_KEY) {
    log.warn({}, 'Settlement skipped: PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set');
    return;
  }

  const payload = event.payload || {};

  // Extract settlement params from event payload
  const buyerDid = payload.buyerDid as string | undefined || event.issuer;
  const amountCents = payload.amount as number | undefined;
  const currency = payload.currency as string | undefined;
  const fairManifest = payload.fairManifest as FairManifest | null | undefined;
  const funded = payload.funded as boolean | undefined;
  const funded_provider = payload.funded_provider as string | undefined;
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  const orderId = payload.orderId as string | undefined || metadata?.orderId as string | undefined;
  const eventId = payload.eventId as string | undefined || metadata?.eventId as string | undefined;
  const service = payload.settle_service as string | undefined || event.scope;
  const type = payload.settle_type as string | undefined || event.type;

  if (!amountCents || typeof amountCents !== 'number') {
    log.warn({ event: event.type }, 'Settlement skipped: amount missing or invalid');
    return;
  }

  // Resolve .fair chain if provided
  let resolvedChain: Array<{ did: string; amount: number; role: string }> | undefined;
  let expectedTotal: number | undefined;

  const chain = fairManifest?.chain;
  if (fairManifest && chain?.length) {
    const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
    if (!NODE_DID) {
      log.warn({ event: event.type }, '[settle] NODE_DID not set — node fee recipient unresolved');
    }

    const result = resolveSettlementChain({
      amountCents,
      chain,
      fees: fairManifest.fees,
      buyerDid: buyerDid ?? '',
      nodeDid: NODE_DID,
    });
    resolvedChain = result.resolvedChain;
    expectedTotal = result.expectedTotal;
  }

  const body: Record<string, unknown> = {
    from_did: buyerDid,
    total_amount: expectedTotal ?? amountCents / 100,
    service,
    type,
  };

  if (funded !== undefined) body.funded = funded;
  if (funded_provider) body.funded_provider = funded_provider;
  if (currency) body.currency = currency;
  if (resolvedChain) body.fair_manifest = { chain: resolvedChain };
  if (metadata) body.metadata = metadata;

  let result: { settled: boolean; batchId: string; transactions: string[]; total_amount: number; recipients: number; source: string } | undefined;

  try {
    const response = await fetch(`${PAY_SERVICE_URL}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, text }, 'Settlement request failed');
      return;
    }

    result = await response.json() as typeof result;
    log.info({ event: event.type, buyerDid, amount: amountCents, batchId: result?.batchId }, 'Settlement complete');
  } catch (err) {
    log.error({ err: String(err) }, 'Settlement request error');
    return;
  }

  // Emit settlement.completed so downstream services can snapshot the receipt
  if (result?.settled) {
    if (!orderId) {
      log.warn({ event: event.type }, 'Settlement completed but orderId is missing; skipping settlement.completed publish');
      return;
    }
    const resolvedFees = (fairManifest?.fees || []).map((fee) => ({
      role: fee.role,
      name: fee.name,
      rateBps: fee.rateBps,
      fixedCents: fee.fixedCents,
      amount: Number.parseFloat((computeFeeCents(amountCents, fee.rateBps, fee.fixedCents) / 100).toFixed(2)),
      estimated: true,
    }));

    try {
      await publish('settlement.completed', {
        issuer: buyerDid || event.issuer,
        subject: event.subject,
        scope: event.scope,
        payload: {
          orderId,
          eventId: eventId || '',
          buyerDid: buyerDid || event.issuer,
          amount: amountCents,
          currency: currency || 'CAD',
          totalAmount: amountCents / 100,
          netAmount: expectedTotal ?? amountCents / 100,
          fees: resolvedFees,
          chain: resolvedChain || [],
          metadata,
        },
      });
      log.info({ event: event.type, buyerDid, amount: amountCents }, 'Settlement completed event emitted');
    } catch (publishErr) {
      log.error({ err: String(publishErr) }, 'Failed to emit settlement.completed (non-fatal)');
    }
  }
};
