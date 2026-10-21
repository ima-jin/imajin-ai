import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineAction, migrationChecksum } from '../lib/kernel-baseline.mjs';

const manifest = {
  filename: '0001_kernel_baseline.sql',
  migrations: [{ filename: '0001_seed.sql', checksum: 'a' }, { filename: '0201_reconcile.sql', checksum: 'b' }],
};
const full = () => new Map(manifest.migrations.map(entry => [entry.filename, entry.checksum]));
it('verifies all-post-cut replay, ledger preservation and repeat-run checks', () => {
  execFileSync('python3', [fileURLToPath(new URL('./test_kernel_baseline_check.py', import.meta.url))], { stdio: 'pipe' });
});

describe('kernel baseline adoption', () => {
  it('initializes only an empty untracked database', () => {
    expect(baselineAction(manifest, new Map(), 'hash', false)).toBe('apply');
    expect(() => baselineAction(manifest, new Map(), 'hash', true)).toThrow('Untracked');
    expect(() => baselineAction(manifest, new Map([['unknown.sql', 'x']]), 'hash', false)).toThrow('Untracked');
  });
  it('adopts only a complete matching historical ledger with kernel schemas', () => {
    expect(baselineAction(manifest, full(), 'hash', true)).toBe('adopt');
    expect(() => baselineAction(manifest, full(), 'hash', false)).toThrow('without kernel');
    expect(() => baselineAction(manifest, full(), 'hash', true, false)).toThrow('incomplete adoption');
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

const documented = JSON.parse(readFileSync(new URL('../../migrations/kernel-baseline.json', import.meta.url), 'utf8'));
const reviewed = [
  ['0001_seed.sql', '9d75ca47c372992e02a178b5d6001ee3689e77b8fa94ad14fa1cdf75843d8aea', ['dev', 'prod']],
  ['0010_logs_cleanup.sql', '455f387dd93c5f36843d5a278840e593556f5590d8973e8b9346dc2b67021a39', ['dev', 'prod']],
  ['0039_seed_bus_chain_configs.sql', 'cc5ed2c9bafb8b1f2b8ab04d9149f2ede9706c3a74d8f8cc9d45cee032b28a59', ['dev', 'prod']],
  ['0042_seed_calendar_chain_configs.sql', 'a17b873c79706f08e4996784f3fa18af13f6fb2744311a3516cb02374bb659dc', ['dev', 'prod']],
  ['0056_consent_grants.sql', '89e67ab66003769e9e05bd7ec2865c97a16a6573d1018647f57785433fcc1775', ['dev']],
  ['0057_profile_field_visibility.sql', 'c1c675e6f4ea6362bcfb9dd0e805bcb458a449afc46b8fa8e9382bc5f0e7cfc7', ['dev']],
  ['0068_inference_engine.sql', '16edc9b984bbf7e4f512aa638ec52734a939682eb8e8ea67a2dc326aaee0d5d8', ['dev']],
  ['0071_inference_attestation_signatures.sql', 'bdf060a42f7594f281194eebcfd03b5308116ad3440f5e296dd451caf533b43a', ['dev']],
];
const canonicalLedger = () => new Map(documented.migrations.map(entry => [entry.filename, entry.checksum]));
const postFilename = '0216_restore_conversation_members_unique.sql';

describe('reviewed historical ledger drift', () => {
  it('records exactly the eight reviewed filename/checksum variants with provenance', () => {
    expect(Object.keys(documented.acceptedHistoricalChecksums).sort()).toEqual(reviewed.map(([name]) => name).sort());
    for (const [filename, checksum, observedIn] of reviewed) {
      expect(documented.acceptedHistoricalChecksums[filename]).toEqual([{
        checksum, observedIn, reason: expect.any(String),
        evidence: 'https://github.com/ima-jin/imajin-ai/pull/2886#pullrequestreview-5591517061',
      }]);
      expect(documented.acceptedHistoricalChecksums[filename][0].reason.length).toBeGreaterThan(0);
    }
  });
  it.each(['dev', 'prod'])('adopts the exact %s variants without changing the supplied ledger', environment => {
    const ledger = canonicalLedger();
    for (const [filename, checksum, observedIn] of reviewed) {
      if (observedIn.includes(environment)) ledger.set(filename, checksum);
    }
    if (environment === 'dev') {
      ledger.set(postFilename, migrationChecksum(readFileSync(new URL(`../../migrations/${postFilename}`, import.meta.url))));
    }
    const before = [...ledger];
    expect(baselineAction(documented, ledger, 'baseline-hash', true)).toBe('adopt');
    expect([...ledger]).toEqual(before);
  });
  it('keeps the cut at 0215 with unchanged 0216 active outside the required history', () => {
    expect(documented.migrations.at(-1).filename).toBe('0215_registry_apps_sign_in_audience.sql');
    expect(documented.migrations).toHaveLength(212);
    expect(documented.migrations.some(entry => entry.filename === postFilename)).toBe(false);
    expect(readFileSync(new URL(`../../migrations/${postFilename}`, import.meta.url), 'utf8'))
      .toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_members_unique');
  });
  it('rejects an unrecorded checksum and a recorded checksum borrowed from a different file', () => {
    const ledger = canonicalLedger();
    ledger.set('0001_seed.sql', '0'.repeat(64));
    expect(() => baselineAction(documented, ledger, 'baseline-hash', true)).toThrow('Historical checksum mismatch: 0001_seed.sql');
    ledger.set('0001_seed.sql', reviewed[1][1]);
    expect(() => baselineAction(documented, ledger, 'baseline-hash', true)).toThrow('Historical checksum mismatch: 0001_seed.sql');
  });
  it('still requires every pre-cut row, including 0215', () => {
    const ledger = canonicalLedger();
    ledger.delete('0215_registry_apps_sign_in_audience.sql');
    expect(() => baselineAction(documented, ledger, 'baseline-hash', true)).toThrow('Incomplete pre-baseline ledger');
  });
});
