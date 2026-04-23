import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:settle');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

const SELLER_ROLES = new Set(['seller', 'creator', 'event']);

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
    const totalDollars = amountCents / 100;

    const NODE_DID = process.env.NODE_DID || process.env.RELAY_IMAJIN_DID || null;
    if (!NODE_DID) {
      log.warn({ event: event.type }, '[settle] NODE_DID not set — node fee recipient unresolved');
    }

    // Calculate estimated processing fee to deduct from seller's share
    const fees = fairManifest.fees || [];
    const processorFee = fees.find(f => f.role === 'processor');
    const estimatedFeeDollars = processorFee
      ? parseFloat(((amountCents * processorFee.rateBps / 10000 + processorFee.fixedCents) / 100).toFixed(2))
      : parseFloat(((amountCents * 370 / 10000 + 30) / 100).toFixed(2)); // fallback: 3.7% + 30¢

    // Replace placeholder DIDs and deduct processing fee from seller
    resolvedChain = chain.map((entry) => {
      let did = entry.did;
      if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
      if (did === 'NODE_PLACEHOLDER') did = NODE_DID || 'did:imajin:node-unresolved';

      let entryAmount = parseFloat((totalDollars * entry.share).toFixed(2));

      if (SELLER_ROLES.has(entry.role)) {
        entryAmount = parseFloat((entryAmount - estimatedFeeDollars).toFixed(2));
      }

      return { did, amount: entryAmount, role: entry.role };
    });

    expectedTotal = parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));

    // Fix rounding drift
    const chainSum = resolvedChain.reduce((sum, e) => sum + e.amount, 0);
    const drift = parseFloat((expectedTotal - chainSum).toFixed(2));
    if (drift !== 0 && resolvedChain.length > 0) {
      const seller = resolvedChain.find(e => SELLER_ROLES.has(e.role));
      const target = seller || resolvedChain.reduce((max, e) => e.amount > max.amount ? e : max, resolvedChain[0]);
      target.amount = parseFloat((target.amount + drift).toFixed(2));
    }
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

    log.info({ event: event.type, buyerDid, amount: amountCents }, 'Settlement complete');
  } catch (err) {
    log.error({ err: String(err) }, 'Settlement request error');
  }
};
