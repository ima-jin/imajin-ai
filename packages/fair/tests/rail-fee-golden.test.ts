/**
 * Golden test (#2177 item 2): the default (Stripe) rail's manifest and
 * settlement output is byte-for-byte unchanged by the rail-keyed
 * `processorFee` lookup refactor.
 *
 * `fixtures/stripe-rail-golden.json` was recorded against the code BEFORE
 * the refactor (`UPDATE_GOLDEN=1 pnpm vitest run tests/rail-fee-golden`) and
 * is compared with deep equality on the exact JSON serialisation, so any
 * drift in fee entries, per-seller processor splits (#2472/#2545), tax
 * grossing (#2419), or rounding shows up as a diff here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFairManifest } from '../src/buildManifest';
import { resolveSettlementChain } from '../src/settlement';
import type { FairSettlementEntry, FairSettlementTax } from '../src/settlement';
import { getDefaultManifest } from '../src/templates';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stripe-rail-golden.json');

const CREATOR = 'did:imajin:creator';
const CONTENT = 'did:imajin:content';
const SCOPE = 'did:imajin:scope';
const BUYER = 'did:imajin:buyer';
const NODE = 'did:imajin:node';

const TAX = {
  jurisdiction: 'CA-ON',
  kind: 'HST',
  rateBps: 1300,
  registrationNumber: '123456789RT0001',
  collectorDid: 'did:imajin:collector',
  remitTo: 'did:imajin:authority:ca-cra',
};

const AMOUNTS = [1, 30, 99, 100, 333, 1234, 10_001, 99_999, 500_000];

const CHAINS: Record<string, FairSettlementEntry[]> = {
  'standard split': [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.005 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.0025 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.01 },
    { did: CREATOR, role: 'seller', share: 0.9725 },
  ],
  'multi-seller pro rata (#2472)': [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.01 },
    { did: 'did:imajin:a', role: 'seller', share: 0.5 },
    { did: 'did:imajin:b', role: 'creator', share: 0.3 },
    { did: 'did:imajin:c', role: 'event', share: 0.18 },
  ],
  'no seller-role entry': [
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.4 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.6 },
  ],
};

function manifestCases(): Record<string, unknown> {
  const base = { creatorDid: CREATOR, contentDid: CONTENT, contentType: 'image/png' };
  const taxed = { ...base, taxes: [TAX], basisAmountCents: 10_000 };
  return {
    default: buildFairManifest(base),
    scope: buildFairManifest({ ...base, scopeDid: SCOPE, scopeFeeBps: 50 }),
    collaborators: buildFairManifest({
      ...base,
      nodeFeeBps: 100,
      buyerCreditBps: 50,
      nodeOperatorDid: NODE,
      collaborators: [
        { did: 'did:imajin:x', role: 'author', share: 0.6 },
        { did: 'did:imajin:y', role: 'editor', share: 0.4 },
      ],
    }),
    taxed: buildFairManifest(taxed),
    // `created` is a wall-clock timestamp — drop it so the output is deterministic.
    defaultTemplate: { ...getDefaultManifest('image/png', CREATOR), created: undefined },
    defaultTemplateText: { ...getDefaultManifest('text/markdown', CREATOR), created: undefined },
  };
}

function settlementCases(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fees = buildFairManifest({ creatorDid: CREATOR, contentDid: CONTENT, contentType: 'x' }).fees;
  const taxes: FairSettlementTax[] = [
    { ...TAX, basisAmount: 0, amount: 0 },
  ];
  for (const [chainName, chain] of Object.entries(CHAINS)) {
    for (const amountCents of AMOUNTS) {
      const base = { amountCents, chain, buyerDid: BUYER, nodeDid: NODE };
      // Manifest-supplied processor fee entry (the shape every real manifest carries).
      out[`${chainName} | ${amountCents} | manifest fees`] = resolveSettlementChain({ ...base, fees });
      // No `processor` entry → built-in fallback estimate.
      out[`${chainName} | ${amountCents} | fallback`] = resolveSettlementChain(base);
      // Taxed: processor fee is computed on the GROSS amount (#2419).
      const taxRow = { ...taxes[0]!, basisAmount: amountCents, amount: Math.round((amountCents * TAX.rateBps) / 10_000) };
      out[`${chainName} | ${amountCents} | taxed`] = resolveSettlementChain({ ...base, fees, taxes: [taxRow] });
    }
  }
  return out;
}

/** Normalise via JSON so `undefined`-valued keys and float formatting compare exactly as serialised. */
function snapshot(): unknown {
  return JSON.parse(JSON.stringify({ manifests: manifestCases(), settlements: settlementCases() }));
}

describe('Stripe-rail golden output (pre-refactor baseline)', () => {
  if (process.env.UPDATE_GOLDEN === '1') {
    it('records the golden fixture', () => {
      writeFileSync(FIXTURE_PATH, JSON.stringify(snapshot(), null, 2) + '\n');
    });
    return;
  }

  const golden = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
    manifests: Record<string, unknown>;
    settlements: Record<string, unknown>;
  };
  const current = snapshot() as typeof golden;

  it.each(Object.keys(golden.manifests))('manifest "%s" is byte-for-byte unchanged', (name) => {
    expect(JSON.stringify(current.manifests[name])).toBe(JSON.stringify(golden.manifests[name]));
  });

  it.each(Object.keys(golden.settlements))('settlement "%s" is byte-for-byte unchanged', (name) => {
    expect(JSON.stringify(current.settlements[name])).toBe(JSON.stringify(golden.settlements[name]));
  });

  it('covers exactly the recorded case set (no case silently dropped)', () => {
    expect(Object.keys(current.manifests)).toEqual(Object.keys(golden.manifests));
    expect(Object.keys(current.settlements)).toEqual(Object.keys(golden.settlements));
  });
});
