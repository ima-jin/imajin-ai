/**
 * Tests for apps/kernel/src/lib/kernel/app-act-as.ts (#2639 / #2644).
 *
 * The mint-time decision: the operator flag composed with the EXISTING
 * `validateActingAs` gate (mocked here — its own behaviour is covered by the
 * requireAuth tests). No per-request logic lives here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ validateActingAsMock: vi.fn() }));
vi.mock('@imajin/auth', () => ({ validateActingAs: mocks.validateActingAsMock }));

import {
  resolveMintActAs,
  ACT_AS_NOT_APPROVED_ERROR,
  ACT_AS_NOT_AUTHORIZED_ERROR,
  ACT_AS_INVALID_ERROR,
} from '../app-act-as';

const USER_DID = 'did:imajin:user-abc';
const GROUP_DID = 'did:imajin:group-xyz';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateActingAsMock.mockResolvedValue({ valid: true, role: 'owner', allowedServices: null });
});

describe('resolveMintActAs (#2639 / #2644)', () => {
  it('does nothing when no actAs is requested — no gate call, even for an unapproved app', async () => {
    expect(await resolveMintActAs(undefined, USER_DID, { actAsAllowed: false })).toEqual({ actingAs: undefined });
    expect(await resolveMintActAs(null, USER_DID, { actAsAllowed: false })).toEqual({ actingAs: undefined });
    expect(mocks.validateActingAsMock).not.toHaveBeenCalled();
  });

  it.each([[''], ['   '], [42], [{ did: GROUP_DID }], [[GROUP_DID]]])('refuses a malformed actAs (%j) with 400', async (bad) => {
    const result = await resolveMintActAs(bad, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ refusal: ACT_AS_INVALID_ERROR, status: 400 });
    expect(mocks.validateActingAsMock).not.toHaveBeenCalled();
  });

  it('refuses with 403 when the operator has not approved act-as for the app, without consulting the group gate', async () => {
    const result = await resolveMintActAs(GROUP_DID, USER_DID, { actAsAllowed: false });

    expect(result).toEqual({ refusal: ACT_AS_NOT_APPROVED_ERROR, status: 403 });
    expect(mocks.validateActingAsMock).not.toHaveBeenCalled();
  });

  it('refuses with 403 when the caller lacks authority over the group (existing gate says invalid)', async () => {
    mocks.validateActingAsMock.mockResolvedValue({ valid: false });

    const result = await resolveMintActAs(GROUP_DID, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ refusal: ACT_AS_NOT_AUTHORIZED_ERROR, status: 403 });
  });

  it('runs the existing gate once, for the caller and the requested group, and returns the group DID on success', async () => {
    const result = await resolveMintActAs(GROUP_DID, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ actingAs: GROUP_DID });
    expect(mocks.validateActingAsMock).toHaveBeenCalledTimes(1);
    expect(mocks.validateActingAsMock).toHaveBeenCalledWith(USER_DID, GROUP_DID);
  });

  it('trims the requested DID before checking and returning it', async () => {
    const result = await resolveMintActAs(`  ${GROUP_DID}  `, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ actingAs: GROUP_DID });
    expect(mocks.validateActingAsMock).toHaveBeenCalledWith(USER_DID, GROUP_DID);
  });

  it('refuses a controller restricted to specific services — narrower than the ruling', async () => {
    mocks.validateActingAsMock.mockResolvedValue({ valid: true, role: 'admin', allowedServices: ['events'] });

    const result = await resolveMintActAs(GROUP_DID, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ refusal: ACT_AS_NOT_AUTHORIZED_ERROR, status: 403 });
  });

  it('accepts a controller whose allowedServices list is empty (no restriction)', async () => {
    mocks.validateActingAsMock.mockResolvedValue({ valid: true, role: 'owner', allowedServices: [] });

    const result = await resolveMintActAs(GROUP_DID, USER_DID, { actAsAllowed: true });

    expect(result).toEqual({ actingAs: GROUP_DID });
  });
});
