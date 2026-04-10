import { describe, it, expect } from 'vitest';

/**
 * Fee subdivision logic extracted for unit testing.
 * Mirrors the logic in handleCheckoutCompleted in route.ts.
 */

type ManifestEntry = { did: string; role: string; share: number };

function subdivideFees(
  chain: ManifestEntry[],
  totalAmountCents: number,
  currency: string,
  buyerDid: string | null,
): Array<{
  recipientDid: string;
  role: string;
  amountCents: number;
  currency: string;
  status: string;
}> {
  const results = [];

  for (const entry of chain) {
    const amountCents = Math.round(totalAmountCents * entry.share);
    if (amountCents <= 0) continue;

    const recipientDid = entry.did === 'BUYER_PLACEHOLDER' ? (buyerDid || 'unresolved') : entry.did;
    const isSeller = entry.role === 'seller';
    const status = isSeller ? 'paid_out' : 'accrued';

    results.push({ recipientDid, role: entry.role, amountCents, currency, status });
  }

  return results;
}

describe('fee subdivision', () => {
  const manifest: ManifestEntry[] = [
    { did: 'did:plc:protocol',       role: 'protocol',     share: 0.02 },
    { did: 'did:plc:node',           role: 'node',         share: 0.03 },
    { did: 'BUYER_PLACEHOLDER',      role: 'buyer_credit', share: 0.05 },
    { did: 'did:plc:scope',          role: 'scope',        share: 0.10 },
    { did: 'did:plc:seller',         role: 'seller',       share: 0.80 },
  ];

  const totalCents = 10000; // $100.00
  const currency = 'USD';
  const buyerDid = 'did:plc:buyer123';

  it('calculates correct amountCents for each entry', () => {
    const entries = subdivideFees(manifest, totalCents, currency, buyerDid);
    expect(entries.find(e => e.role === 'protocol')?.amountCents).toBe(200);
    expect(entries.find(e => e.role === 'node')?.amountCents).toBe(300);
    expect(entries.find(e => e.role === 'buyer_credit')?.amountCents).toBe(500);
    expect(entries.find(e => e.role === 'scope')?.amountCents).toBe(1000);
    expect(entries.find(e => e.role === 'seller')?.amountCents).toBe(8000);
  });

  it('resolves BUYER_PLACEHOLDER to actual buyer DID', () => {
    const entries = subdivideFees(manifest, totalCents, currency, buyerDid);
    const buyerEntry = entries.find(e => e.role === 'buyer_credit');
    expect(buyerEntry?.recipientDid).toBe(buyerDid);
  });

  it('resolves BUYER_PLACEHOLDER to "unresolved" when buyerDid is null', () => {
    const entries = subdivideFees(manifest, totalCents, currency, null);
    const buyerEntry = entries.find(e => e.role === 'buyer_credit');
    expect(buyerEntry?.recipientDid).toBe('unresolved');
  });

  it('gives seller status "paid_out", all others "accrued"', () => {
    const entries = subdivideFees(manifest, totalCents, currency, buyerDid);
    for (const entry of entries) {
      if (entry.role === 'seller') {
        expect(entry.status).toBe('paid_out');
      } else {
        expect(entry.status).toBe('accrued');
      }
    }
  });

  it('skips entries with zero amountCents', () => {
    const sparseManifest: ManifestEntry[] = [
      { did: 'did:plc:a', role: 'protocol', share: 0 },
      { did: 'did:plc:b', role: 'seller', share: 1.0 },
    ];
    const entries = subdivideFees(sparseManifest, 500, currency, null);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('seller');
  });

  it('passes through currency correctly', () => {
    const entries = subdivideFees(manifest, totalCents, 'CAD', buyerDid);
    expect(entries.every(e => e.currency === 'CAD')).toBe(true);
  });
});
