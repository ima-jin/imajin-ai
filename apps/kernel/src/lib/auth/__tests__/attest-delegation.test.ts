/**
 * Unit tests for attest:<appId>:<type> app-delegated attestation grant
 * capability validation (#2394).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  isRegisteredAttestationType: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (..._args: unknown[]) => ({
          limit: h.selectLimit,
        }),
      }),
    }),
  },
  registryApps: { id: 'id', appDid: 'appDid', status: 'status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => args,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('../attestation-type-registry', () => ({
  isRegisteredAttestationType: h.isRegisteredAttestationType,
}));

// @imajin/auth is used for real here — ATTESTATION_TYPES and
// parseAttestDelegationCapability are pure and already covered in
// packages/auth/tests/grant-scopes.test.ts; exercising the real
// implementations keeps this file's DB-integration focus honest.
import {
  resolveActiveAttestDelegationApp,
  validateAttestDelegationCapabilities,
} from '../attest-delegation';

const APP_ID = 'app_dykil123';
const APP_DID = 'did:imajin:app-dykil';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveActiveAttestDelegationApp', () => {
  it('returns the row for an active app', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);

    const result = await resolveActiveAttestDelegationApp(APP_ID);

    expect(result).toEqual({ id: APP_ID, appDid: APP_DID, status: 'active' });
  });

  it('returns null when no row exists', async () => {
    h.selectLimit.mockResolvedValue([]);

    expect(await resolveActiveAttestDelegationApp(APP_ID)).toBeNull();
  });

  it('returns null when the row has been revoked', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'revoked' }]);

    expect(await resolveActiveAttestDelegationApp(APP_ID)).toBeNull();
  });

  it('fails closed (returns null) when the lookup throws', async () => {
    h.selectLimit.mockRejectedValue(new Error('db down'));

    expect(await resolveActiveAttestDelegationApp(APP_ID)).toBeNull();
  });
});

describe('validateAttestDelegationCapabilities', () => {
  it('accepts a capability naming an active app (whose own DID matches agentDid) and a built-in attestation type', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:vouch.given`], APP_DID);

    expect(result).toEqual({ valid: [`attest:${APP_ID}:vouch.given`], invalid: [] });
  });

  it('accepts a capability naming a live, registered (non-built-in) attestation type', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);
    h.isRegisteredAttestationType.mockResolvedValue(true);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:dykil/survey_response`], APP_DID);

    expect(result).toEqual({ valid: [`attest:${APP_ID}:dykil/survey_response`], invalid: [] });
    expect(h.isRegisteredAttestationType).toHaveBeenCalledWith('dykil/survey_response');
  });

  it('rejects a capability whose type is neither built-in nor registered', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);
    h.isRegisteredAttestationType.mockResolvedValue(false);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:totally_unknown_type`], APP_DID);

    expect(result).toEqual({ valid: [], invalid: [`attest:${APP_ID}:totally_unknown_type`] });
  });

  it('rejects a capability naming an app that does not exist', async () => {
    h.selectLimit.mockResolvedValue([]);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:vouch.given`], APP_DID);

    expect(result).toEqual({ valid: [], invalid: [`attest:${APP_ID}:vouch.given`] });
  });

  it('rejects a capability naming a revoked app', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'revoked' }]);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:vouch.given`], APP_DID);

    expect(result).toEqual({ valid: [], invalid: [`attest:${APP_ID}:vouch.given`] });
  });

  it("rejects when the app's own DID does not match the grant's agentDid (stops granting one app's slot to a different app)", async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);

    const result = await validateAttestDelegationCapabilities([`attest:${APP_ID}:vouch.given`], 'did:imajin:some-other-app');

    expect(result).toEqual({ valid: [], invalid: [`attest:${APP_ID}:vouch.given`] });
  });

  it('rejects a malformed candidate without ever hitting the database', async () => {
    const result = await validateAttestDelegationCapabilities(['not-an-attest-capability'], APP_DID);

    expect(result).toEqual({ valid: [], invalid: ['not-an-attest-capability'] });
    expect(h.selectLimit).not.toHaveBeenCalled();
  });

  it('validates a batch independently, mixing valid and invalid candidates', async () => {
    h.selectLimit
      .mockResolvedValueOnce([{ id: APP_ID, appDid: APP_DID, status: 'active' }])
      .mockResolvedValueOnce([]);

    const result = await validateAttestDelegationCapabilities(
      [`attest:${APP_ID}:vouch.given`, 'attest:app_unknown:vouch.given'],
      APP_DID,
    );

    expect(result).toEqual({
      valid: [`attest:${APP_ID}:vouch.given`],
      invalid: ['attest:app_unknown:vouch.given'],
    });
  });

  it('keeps candidate order in valid/invalid even when lookups settle out of order', async () => {
    const slowActive = new Promise<unknown[]>((resolve) => {
      setTimeout(() => resolve([{ id: APP_ID, appDid: APP_DID, status: 'active' }]), 20);
    });
    h.selectLimit
      .mockReturnValueOnce(slowActive) // 1st candidate: slow, valid
      .mockResolvedValueOnce([]) // 2nd candidate: fast, invalid
      .mockResolvedValueOnce([{ id: APP_ID, appDid: APP_DID, status: 'active' }]); // 3rd: fast, valid

    const candidates = [
      `attest:${APP_ID}:vouch.given`,
      'attest:app_unknown:vouch.given',
      `attest:${APP_ID}:vouch.received`,
    ];
    const result = await validateAttestDelegationCapabilities(candidates, APP_DID);

    expect(result.valid).toEqual([candidates[0], candidates[2]]);
    expect(result.invalid).toEqual([candidates[1]]);
  });

  it('propagates a failing validation instead of silently classifying the candidate', async () => {
    h.selectLimit.mockResolvedValue([{ id: APP_ID, appDid: APP_DID, status: 'active' }]);
    h.isRegisteredAttestationType.mockRejectedValueOnce(new Error('registry lookup failed'));

    await expect(
      validateAttestDelegationCapabilities([`attest:${APP_ID}:dykil/survey_response`], APP_DID),
    ).rejects.toThrow('registry lookup failed');
  });
});
