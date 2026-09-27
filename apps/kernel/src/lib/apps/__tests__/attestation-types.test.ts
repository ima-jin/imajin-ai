/**
 * Unit tests for `seedAttestationTypes` (#2375) — the app-namespaced
 * attestation-type seeding half of `apps.provision`. Covers the
 * "refused outside the app's own slug prefix" acceptance criterion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { registerAttestationTypeMock } = vi.hoisted(() => ({
  registerAttestationTypeMock: vi.fn(),
}));

vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  registerAttestationType: registerAttestationTypeMock,
}));

import { seedAttestationTypes } from '../attestation-types';

const APP_DID = 'did:imajin:app-dykil';
const SLUG = 'dykil';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('seedAttestationTypes — namespace enforcement', () => {
  it('seeds a type whose prefix matches the slug', async () => {
    registerAttestationTypeMock.mockResolvedValue({ ok: true, entry: { typeName: 'dykil/survey-response' } });

    const outcomes = await seedAttestationTypes(APP_DID, SLUG, ['dykil/survey-response']);

    expect(outcomes).toEqual([{ type: 'dykil/survey-response', ok: true }]);
    expect(registerAttestationTypeMock).toHaveBeenCalledWith({
      registeredByDid: APP_DID,
      handle: SLUG,
      localName: 'survey-response',
    });
  });

  it('refuses a type with no namespace separator, without calling registerAttestationType', async () => {
    const outcomes = await seedAttestationTypes(APP_DID, SLUG, ['not-namespaced']);

    expect(outcomes).toEqual([
      { type: 'not-namespaced', ok: false, error: "'not-namespaced' must be namespaced as 'dykil/<type>'" },
    ]);
    expect(registerAttestationTypeMock).not.toHaveBeenCalled();
  });

  it('refuses a type outside the app\'s own slug prefix', async () => {
    const outcomes = await seedAttestationTypes(APP_DID, SLUG, ['coffee/tip-granted']);

    expect(outcomes).toEqual([
      { type: 'coffee/tip-granted', ok: false, error: "'coffee/tip-granted' is outside the 'dykil/' namespace this app owns — refused" },
    ]);
    expect(registerAttestationTypeMock).not.toHaveBeenCalled();
  });

  it('surfaces a registerAttestationType failure (e.g. reserved namespace) without throwing', async () => {
    registerAttestationTypeMock.mockResolvedValue({ ok: false, error: 'Type already registered' });

    const outcomes = await seedAttestationTypes(APP_DID, SLUG, ['dykil/survey-response']);

    expect(outcomes).toEqual([{ type: 'dykil/survey-response', ok: false, error: 'Type already registered' }]);
  });

  it('processes multiple types independently — one refusal never blocks the rest', async () => {
    registerAttestationTypeMock.mockResolvedValue({ ok: true, entry: {} });

    const outcomes = await seedAttestationTypes(APP_DID, SLUG, [
      'dykil/survey-response',
      'coffee/tip-granted',
      'dykil/survey-response-legacy-import',
    ]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(registerAttestationTypeMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array for an empty types list', async () => {
    const outcomes = await seedAttestationTypes(APP_DID, SLUG, []);
    expect(outcomes).toEqual([]);
    expect(registerAttestationTypeMock).not.toHaveBeenCalled();
  });
});
