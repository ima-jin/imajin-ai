import { describe, expect, it } from 'vitest';
import { baselineAction, migrationChecksum } from '../lib/kernel-baseline.mjs';

const manifest = {
  filename: '0001_kernel_baseline.sql',
  migrations: [{ filename: '0001_seed.sql', checksum: 'a' }, { filename: '0201_reconcile.sql', checksum: 'b' }],
};
const full = () => new Map(manifest.migrations.map(entry => [entry.filename, entry.checksum]));

describe('kernel baseline adoption', () => {
  it('initializes only an empty untracked database', () => {
    expect(baselineAction(manifest, new Map(), 'hash', false)).toBe('apply');
    expect(() => baselineAction(manifest, new Map(), 'hash', true)).toThrow('Untracked');
    expect(() => baselineAction(manifest, new Map([['unknown.sql', 'x']]), 'hash', false)).toThrow('Untracked');
  });
  it('adopts only a complete matching historical ledger with kernel schemas', () => {
    expect(baselineAction(manifest, full(), 'hash', true)).toBe('adopt');
    expect(() => baselineAction(manifest, full(), 'hash', false)).toThrow('without kernel');
    expect(() => baselineAction(manifest, new Map([['0001_seed.sql', 'a']]), 'hash', true)).toThrow('Incomplete');
    const changed = full();
    changed.set('0201_reconcile.sql', 'wrong');
    expect(() => baselineAction(manifest, changed, 'hash', true)).toThrow('checksum mismatch');
  });
  it('skips matching baselines and refuses changed baseline bytes', () => {
    const applied = new Map([[manifest.filename, 'hash']]);
    expect(baselineAction(manifest, applied, 'hash', true)).toBe('skip');
    expect(() => baselineAction(manifest, applied, 'different', true)).toThrow('baseline checksum mismatch');
    expect(migrationChecksum('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
