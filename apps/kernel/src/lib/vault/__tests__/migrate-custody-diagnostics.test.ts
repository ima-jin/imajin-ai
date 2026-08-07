/**
 * Verification-failure diagnostics for the batch custody migrator (#1556).
 *
 * `pollUntilReadable` used to discard every error it caught, so "the Tier 1
 * owner agent has not fulfilled the grant yet" and "the upgrade produced a
 * genuinely broken entry" both surfaced as the same bare timeout string. These
 * pin the distinction: the last error survives the poll loop and is labelled
 * for the operator — *still pending* for a `VaultDelegationError`, *verification
 * failed* for a `VaultIntegrityError`, and the raw message for anything else.
 *
 * Unlike migrate-custody.test.ts, which drives the real crypto path end to end,
 * this file mocks `../index.js` outright. The point here is which error class
 * comes back out of `loadAndUnseal`, and only a stub can produce a
 * `VaultIntegrityError` on demand without corrupting a real entry.
 *
 * `timeoutMs: 0` means the poll makes exactly one attempt before its deadline
 * expires — deterministic, and no wall-clock spinning. It changes nothing about
 * the failure path under test: the timeout branch is reached the same way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrityErrorCode, VaultIntegrityError } from '@imajin/vault-core';

const { mockList, mockLoadAndUnseal, mockSealAndStoreV2 } = vi.hoisted(() => ({
  mockList: vi.fn<() => Promise<Array<Record<string, unknown>>>>(),
  mockLoadAndUnseal: vi.fn<(field: string) => Promise<string | undefined>>(),
  mockSealAndStoreV2: vi.fn<(field: string, plaintext: string) => Promise<{ grantId: string | null }>>(),
}));

vi.mock('../index.js', () => ({
  vaultService: { list: mockList },
  loadAndUnseal: mockLoadAndUnseal,
  sealAndStoreV2: mockSealAndStoreV2,
}));

vi.mock('../sealing.js', () => ({ isVaultTier1: () => false }));

// No pending grant requests: the stale-pending guard must never be what stops
// these runs — the poll failure is.
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
  vaultGrantRequests: { status: 'status', field: 'field', requestId: 'requestId', createdAt: 'createdAt' },
}));

import { VaultDelegationError } from '../errors.js';
import { migrateCustody } from '../migrate-custody.js';

const noSleep = async () => undefined;

/** Plaintext for every field these tests migrate, keyed by field name. */
const PLAINTEXT: Record<string, string> = {
  'field-a': 'secret-a',
  'field-b': 'secret-b',
};

/**
 * Make every listed field look `node-sealed`, readable before its upgrade, and
 * — for the fields named in `failAfterUpgrade` — throw `failure` on every read
 * after `sealAndStoreV2` has run for it. That is the exact shape of a field
 * that upgrades but never verifies.
 */
function arrangeVault(fields: string[], failure: unknown, failAfterUpgrade: string[] = fields): void {
  const upgraded = new Set<string>();

  mockList.mockResolvedValue(fields.map((field) => ({ field, custodyScheme: 'node-sealed' })));

  mockLoadAndUnseal.mockImplementation(async (field: string) => {
    if (upgraded.has(field) && failAfterUpgrade.includes(field)) {
      throw failure;
    }
    return PLAINTEXT[field];
  });

  mockSealAndStoreV2.mockImplementation(async (field: string) => {
    upgraded.add(field);
    return { grantId: `vdg_${field}` };
  });
}

function run() {
  return migrateCustody({ dryRun: false, timeoutMs: 0, pollIntervalMs: 0, sleep: noSleep });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migrateCustody — verification failure diagnostics (#1556)', () => {
  it('labels a VaultDelegationError as still pending, not a broken entry', async () => {
    arrangeVault(
      ['field-a'],
      new VaultDelegationError('no active delegation grant for field-a', {
        field: 'field-a',
        nodeDid: 'did:imajin:node',
      }),
    );

    const report = await run();

    expect(report.aborted).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].status).toBe('verify-failed');

    // The generic timeout is still there — the underlying cause is appended to
    // it, not swapped for it.
    expect(report.results[0].error).toContain("field 'field-a' did not unseal within 0ms after upgrade");
    expect(report.results[0].error).toContain('still pending: no active delegation grant for field-a');
    expect(report.results[0].error).not.toMatch(/verification failed/);

    expect(report.abortReason).toContain("canary field 'field-a' did not come back readable");
    expect(report.abortReason).toContain('still pending: no active delegation grant for field-a');
  });

  it('labels a VaultIntegrityError as verification failed, with its code', async () => {
    arrangeVault(
      ['field-a'],
      new VaultIntegrityError(IntegrityErrorCode.SIGNATURE_INVALID, 'entry signature does not verify', {
        entryField: 'field-a',
      }),
    );

    const report = await run();

    expect(report.aborted).toBe(true);
    expect(report.results[0].status).toBe('verify-failed');
    expect(report.results[0].error).toContain('verification failed (SIGNATURE_INVALID): entry signature does not verify');
    // The whole point: this must not read as a transient wait on an owner agent.
    expect(report.results[0].error).not.toMatch(/still pending/);

    expect(report.abortReason).toContain('verification failed (SIGNATURE_INVALID): entry signature does not verify');
    expect(report.abortReason).not.toMatch(/still pending/);
  });

  it('surfaces the raw message of an error it does not classify', async () => {
    arrangeVault(['field-a'], new Error('Unsupported state or unable to authenticate data'));

    const report = await run();

    expect(report.results[0].error).toContain(
      'verification failed: Unsupported state or unable to authenticate data',
    );
    expect(report.abortReason).toContain(
      'verification failed: Unsupported state or unable to authenticate data',
    );
  });

  it('says so explicitly when nothing threw and the field simply never matched', async () => {
    mockList.mockResolvedValue([{ field: 'field-a', custodyScheme: 'node-sealed' }]);
    // Reads fine before the upgrade, then quietly returns something else — no
    // error to report, which is itself the diagnostic.
    let upgraded = false;
    mockLoadAndUnseal.mockImplementation(async () => (upgraded ? 'a-different-secret' : 'secret-a'));
    mockSealAndStoreV2.mockImplementation(async () => {
      upgraded = true;
      return { grantId: 'vdg_field-a' };
    });

    const report = await run();

    expect(report.results[0].status).toBe('verify-failed');
    expect(report.results[0].error).toContain('no error was raised');
    expect(report.abortReason).toContain('no error was raised');
  });

  it('carries the diagnostic into the abort reason for a non-canary field', async () => {
    // field-a is the canary and verifies cleanly; field-b is the one that breaks.
    arrangeVault(
      ['field-a', 'field-b'],
      new VaultIntegrityError(IntegrityErrorCode.CID_MISMATCH, 'cid does not match sealed blob', {
        entryField: 'field-b',
      }),
      ['field-b'],
    );

    const report = await run();

    expect(report.aborted).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['upgraded', 'verify-failed']);
    expect(report.abortReason).toContain("field 'field-b' failed to verify after upgrade");
    expect(report.abortReason).toContain('verification failed (CID_MISMATCH): cid does not match sealed blob');
    expect(report.abortReason).toContain('aborting with 2 of 2 field(s) processed');
  });

  it('reports an upgrade failure with its own label rather than a poll diagnostic', async () => {
    mockList.mockResolvedValue([{ field: 'field-a', custodyScheme: 'node-sealed' }]);
    mockLoadAndUnseal.mockResolvedValue('secret-a');
    mockSealAndStoreV2.mockRejectedValue(new Error('grant insert failed'));

    const report = await run();

    expect(report.results[0].status).toBe('upgrade-failed');
    expect(report.abortReason).toContain('upgrade failed: grant insert failed');
  });

  it('leaves a clean run untouched — no diagnostic, no abort', async () => {
    mockList.mockResolvedValue([{ field: 'field-a', custodyScheme: 'node-sealed' }]);
    mockLoadAndUnseal.mockResolvedValue('secret-a');
    mockSealAndStoreV2.mockResolvedValue({ grantId: 'vdg_field-a' });

    const report = await run();

    expect(report.aborted).toBe(false);
    expect(report.abortReason).toBeUndefined();
    expect(report.results).toEqual([{ field: 'field-a', status: 'upgraded', grantId: 'vdg_field-a' }]);
  });
});
