import { describe, expect, it } from 'vitest';
import { verifyAgainstPayeeManifest } from '../payee-manifest';

const SELLER = 'did:imajin:seller';
const PLATFORM = 'did:imajin:platform';

const chain = [
  { did: SELLER, role: 'creator', amount: 9.85 },
  { did: PLATFORM, role: 'platform', amount: 0.15 },
];

function verify(recorded: unknown, posted: { chain?: unknown; taxCredits?: unknown }, totalAmount = 10) {
  return verifyAgainstPayeeManifest({ recorded, posted, totalAmount });
}

describe('verifyAgainstPayeeManifest (#2642)', () => {
  it('accepts a posted chain identical to the recorded dollar chain, in any order', () => {
    expect(verify({ chain }, { chain })).toBeNull();
    expect(verify({ chain }, { chain: [...chain].reverse() })).toBeNull();
  });

  it('accepts a recorded share-based chain resolved against the payment total', () => {
    const recorded = { chain: [{ did: SELLER, role: 'creator', share: 0.985 }, { did: PLATFORM, role: 'platform', share: 0.015 }] };
    expect(verify(recorded, { chain })).toBeNull();
  });

  it('tolerates one cent of rounding per entry, no more', () => {
    expect(verify({ chain }, { chain: [{ ...chain[0], amount: 9.86 }, chain[1]] })).toBeNull();
    expect(verify({ chain }, { chain: [{ ...chain[0], amount: 9.9 }, chain[1]] })).toMatch(/amount for 'did:imajin:seller\|creator'/);
  });

  it.each([
    ['no recorded manifest (null)', null],
    ['an array recorded manifest', []],
    ['a string recorded manifest', 'x'],
  ])('refuses %s', (_label, recorded) => {
    expect(verify(recorded, { chain })).toMatch(/no payee manifest was recorded/);
  });

  it('refuses a recorded manifest with no or malformed chain', () => {
    expect(verify({}, { chain })).toMatch(/has no chain/);
    expect(verify({ chain: [] }, { chain })).toMatch(/has no chain/);
    expect(verify({ chain: [{ did: SELLER, role: 'creator' }] }, { chain })).toMatch(/without did, role and amount\/share/);
    expect(verify({ chain: [{ did: SELLER, role: 'creator', share: 1.5 }] }, { chain })).toMatch(/without did, role and amount\/share/);
    expect(verify({ chain: [{ role: 'creator', amount: 1 }] }, { chain })).toMatch(/without did, role and amount\/share/);
  });

  it('refuses a posted chain that is not an array of well-formed entries', () => {
    expect(verify({ chain }, { chain: 'x' })).toMatch(/must be an array/);
    expect(verify({ chain }, { chain: [{ did: SELLER, role: 'creator' }] })).toMatch(/need did, role and amount/);
    expect(verify({ chain }, { chain: [1] })).toMatch(/must be an array/);
  });

  it('refuses extra, missing, re-roled and re-addressed payees', () => {
    expect(verify({ chain }, { chain: [...chain, { did: 'did:imajin:x', role: 'other', amount: 1 }] })).toMatch(/has 3 entries, recorded payee manifest has 2/);
    expect(verify({ chain }, { chain: [chain[0]] })).toMatch(/has 1 entries/);
    expect(verify({ chain }, { chain: [{ ...chain[0], role: 'seller' }, chain[1]] })).toMatch(/is not in the recorded payee manifest/);
    expect(verify({ chain }, { chain: [{ ...chain[0], did: 'did:imajin:thief' }, chain[1]] })).toMatch(/is not in the recorded payee manifest/);
  });

  it('pairs duplicate did|role entries deterministically by amount', () => {
    const dup = [{ did: SELLER, role: 'creator', amount: 6 }, { did: SELLER, role: 'creator', amount: 4 }];
    expect(verify({ chain: dup }, { chain: [dup[1], dup[0]] })).toBeNull();
    expect(verify({ chain: dup }, { chain: [dup[0], { ...dup[1], amount: 5 }] })).toMatch(/does not match/);
  });

  describe('tax rows', () => {
    const taxCredit = { did: SELLER, amount: 0.5, jurisdiction: 'CA-ON', kind: 'HST', rateBps: 500, remitTo: 'cra', registrationNumber: 'RT1' };

    it('accepts recorded checkout `taxes[]` (cents, collectorDid) against posted `taxCredits` (dollars, did)', () => {
      const recorded = { chain, taxes: [{ jurisdiction: 'CA-ON', kind: 'HST', amount: 50, basisAmount: 1000, collectorDid: SELLER }] };
      expect(verify(recorded, { chain, taxCredits: [taxCredit] }, 10.5)).toBeNull();
    });

    it('accepts recorded `taxCredits[]` (dollars) against posted `taxCredits`', () => {
      expect(verify({ chain, taxCredits: [taxCredit] }, { chain, taxCredits: [taxCredit] })).toBeNull();
    });

    it('treats null/undefined posted taxCredits as none, and requires the recorded manifest to carry none too', () => {
      expect(verify({ chain }, { chain, taxCredits: null })).toBeNull();
      expect(verify({ chain }, { chain, taxCredits: [taxCredit] })).toMatch(/taxCredits has 1 entries, recorded payee manifest has 0/);
      expect(verify({ chain, taxCredits: [taxCredit] }, { chain })).toMatch(/taxCredits has 0 entries/);
    });

    it('refuses a changed tax amount or collector', () => {
      const recorded = { chain, taxCredits: [taxCredit] };
      expect(verify(recorded, { chain, taxCredits: [{ ...taxCredit, amount: 5 }] })).toMatch(/taxCredits amount/);
      expect(verify(recorded, { chain, taxCredits: [{ ...taxCredit, did: 'did:imajin:thief' }] })).toMatch(/is not in the recorded payee manifest/);
    });

    it('refuses malformed recorded or posted tax rows', () => {
      expect(verify({ chain, taxCredits: [{ did: SELLER }] }, { chain })).toMatch(/malformed taxCredits/);
      expect(verify({ chain, taxes: [{ kind: 'HST' }] }, { chain })).toMatch(/malformed taxes/);
      expect(verify({ chain }, { chain, taxCredits: 'x' })).toMatch(/taxCredits must be an array/);
      expect(verify({ chain }, { chain, taxCredits: [{ did: SELLER }] })).toMatch(/taxCredits entries need/);
    });
  });
});
