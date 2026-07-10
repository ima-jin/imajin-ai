import { describe, it, expect, vi } from 'vitest';

const { whereMock } = vi.hoisted(() => ({ whereMock: vi.fn() }));

vi.mock('@/src/db', () => ({
  db: { update: () => ({ set: () => ({ where: whereMock }) }) },
  supplyLots: { correlationId: 'correlation_id' },
}));

import { buildSaleFairManifest, attachFairManifestToLot } from '../settlement';

describe('supply settlement — .fair manifest at invoice creation (#1210)', () => {
  it('builds a manifest with the supplier as the seller and shares summing to 1', () => {
    const manifest = buildSaleFairManifest('did:imajin:scott', 'lot_eggs_1');

    const seller = manifest.chain.find((entry) => entry.role === 'seller');
    expect(seller?.did).toBe('did:imajin:scott');

    const totalShare = manifest.chain.reduce((sum, entry) => sum + entry.share, 0);
    expect(totalShare).toBeCloseTo(1, 6);
  });

  it('persists the manifest onto the lot by correlationId', async () => {
    whereMock.mockResolvedValue(undefined);
    const manifest = buildSaleFairManifest('did:imajin:scott', 'lot_eggs_1');

    await attachFairManifestToLot('lot_eggs_1', manifest);

    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
