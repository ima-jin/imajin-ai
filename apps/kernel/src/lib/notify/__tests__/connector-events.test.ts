/**
 * Tests for connector-events.ts (#2205): the kernel's emission of
 * `connector.credential.sealed` / `connector.credential.unsealed` /
 * `connector.models.changed` over the existing per-DID WS notification
 * transport.
 *
 * `@/src/db` and `./ws-push` are mocked so these are pure unit tests of the
 * emission logic — no real DB, no real HTTP push — mirroring
 * `connector-registry-store.test.ts`'s approach to the sibling fail-open
 * contract these notifications must also honor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValues, updateSets, insertMock, updateMock, selectMock, pushMock, buildFrameMock, getConnectorMock } = vi.hoisted(() => {
  const insertValues: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const insertMock = vi.fn(() => ({
    values: (v: Record<string, unknown>) => {
      insertValues.push(v);
      return Promise.resolve();
    },
  }));
  const updateMock = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      updateSets.push(s);
      return { where: async () => undefined };
    },
  }));
  // #1510 — template-store.ts's getTemplate() reads notify.templates via
  // db.select(); returning no rows here keeps this suite's existing
  // assertions unchanged by falling back to the in-code registry, same as
  // before template-store.ts existed.
  const selectMock = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }));
  return {
    insertValues,
    updateSets,
    insertMock,
    updateMock,
    selectMock,
    pushMock: vi.fn(),
    buildFrameMock: vi.fn((input: Record<string, unknown>) => ({ type: 'notification', ...input })),
    getConnectorMock: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { insert: insertMock, update: updateMock, select: selectMock },
  notifications: { id: 'id' },
  notifyTemplates: { scope: 'scope' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/connector-registry', () => ({
  getConnector: getConnectorMock,
}));

vi.mock('../ws-push', () => ({
  buildNotificationFrame: buildFrameMock,
  pushNotificationToDid: pushMock,
}));

import {
  CONNECTOR_CREDENTIAL_SEALED_SCOPE,
  CONNECTOR_CREDENTIAL_UNSEALED_SCOPE,
  CONNECTOR_MODELS_CHANGED_SCOPE,
  notifyConnectorCredentialSealed,
  notifyConnectorCredentialUnsealed,
  notifyConnectorModelsChanged,
} from '../connector-events';

const PRINCIPAL = 'did:imajin:chris';

beforeEach(() => {
  insertValues.length = 0;
  updateSets.length = 0;
  insertMock.mockClear();
  updateMock.mockClear();
  pushMock.mockReset().mockResolvedValue(true);
  buildFrameMock.mockClear();
  getConnectorMock.mockReset();
});

// ── notifyConnectorCredentialSealed ────────────────────────────────────────

describe('notifyConnectorCredentialSealed', () => {
  it('persists + pushes a connector.credential.sealed frame with no secret material', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: '/gemini/api/models' });

    await notifyConnectorCredentialSealed(PRINCIPAL, 'gemini');

    const sealedRow = insertValues.find((v) => v.scope === CONNECTOR_CREDENTIAL_SEALED_SCOPE);
    expect(sealedRow).toMatchObject({
      recipientDid: PRINCIPAL,
      scope: CONNECTOR_CREDENTIAL_SEALED_SCOPE,
      data: { provider: 'gemini' },
    });
    // Only ever provider (+ hint, for models.changed) — never a key, token, or field name.
    expect(Object.keys(sealedRow!.data as object).sort()).toEqual(['provider']);
  });

  it('also emits connector.models.changed when the provider feeds the inference catalog', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: '/gemini/api/models' });

    await notifyConnectorCredentialSealed(PRINCIPAL, 'gemini');

    const changedRow = insertValues.find((v) => v.scope === CONNECTOR_MODELS_CHANGED_SCOPE);
    expect(changedRow).toMatchObject({
      recipientDid: PRINCIPAL,
      scope: CONNECTOR_MODELS_CHANGED_SCOPE,
      data: { provider: 'gemini', hint: 'credential-sealed' },
    });
    expect(insertValues).toHaveLength(2);
  });

  it('does not emit connector.models.changed for a connector with no model catalog', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: null });

    await notifyConnectorCredentialSealed(PRINCIPAL, 'stripe');

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0].scope).toBe(CONNECTOR_CREDENTIAL_SEALED_SCOPE);
  });

  it('treats an unknown provider id as not affecting the model catalog', async () => {
    getConnectorMock.mockReturnValue(undefined);

    await notifyConnectorCredentialSealed(PRINCIPAL, 'not-a-connector');

    expect(insertValues).toHaveLength(1);
  });
});

// ── notifyConnectorCredentialUnsealed ──────────────────────────────────────

describe('notifyConnectorCredentialUnsealed', () => {
  it('emits connector.credential.unsealed plus connector.models.changed with the unsealed hint', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: '/xai/api/models' });

    await notifyConnectorCredentialUnsealed(PRINCIPAL, 'xai');

    expect(insertValues.map((v) => v.scope)).toEqual([
      CONNECTOR_CREDENTIAL_UNSEALED_SCOPE,
      CONNECTOR_MODELS_CHANGED_SCOPE,
    ]);
    const changedRow = insertValues[1];
    expect(changedRow.data).toEqual({ provider: 'xai', hint: 'credential-unsealed' });
  });

  it('emits only the credential scope for a non-catalog connector', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: null });

    await notifyConnectorCredentialUnsealed(PRINCIPAL, 'gcp');

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0].scope).toBe(CONNECTOR_CREDENTIAL_UNSEALED_SCOPE);
  });
});

// ── notifyConnectorModelsChanged (direct) ──────────────────────────────────

describe('notifyConnectorModelsChanged', () => {
  it('pushes the frame over the existing per-DID WS transport, keyed to the recipient', async () => {
    await notifyConnectorModelsChanged(PRINCIPAL, 'openai', 'catalog-update');

    expect(pushMock).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({
      scope: CONNECTOR_MODELS_CHANGED_SCOPE,
      data: { provider: 'openai', hint: 'catalog-update' },
    }));
  });

  it('records channelsSent as delivered when the push reaches an open socket', async () => {
    pushMock.mockResolvedValue(true);

    await notifyConnectorModelsChanged(PRINCIPAL, 'openai', 'catalog-update');

    expect(updateSets[0]).toEqual({ channelsSent: ['inapp', 'ws'] });
  });

  it('records channelsSent without ws when nobody was connected', async () => {
    pushMock.mockResolvedValue(false);

    await notifyConnectorModelsChanged(PRINCIPAL, 'openai', 'catalog-update');

    expect(updateSets[0]).toEqual({ channelsSent: ['inapp'] });
  });
});

// ── Acting delegate (#2366) ──────────────────────────────────────────
//
// Connector use is owner-facing, so it obeys the same rule as the projection
// alert: when an app drove the transition the frame carries the `{did, appDid}`
// pair so the template can name that delegate. Still no credential material.

const ACTING_APP = 'did:imajin:ADEKzzzzzzzzzzzzzzzzzzzzzzzzzzzzn54k';

describe('acting delegate attribution (#2366)', () => {
  it('carries the {did, appDid} pair on a delegated seal, and on its models.changed', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: '/gemini/api/models' });

    await notifyConnectorCredentialSealed(PRINCIPAL, 'gemini', ACTING_APP);

    const sealedRow = insertValues.find((v) => v.scope === CONNECTOR_CREDENTIAL_SEALED_SCOPE);
    expect(sealedRow!.data).toEqual({ provider: 'gemini', did: PRINCIPAL, appDid: ACTING_APP });

    const changedRow = insertValues.find((v) => v.scope === CONNECTOR_MODELS_CHANGED_SCOPE);
    expect(changedRow!.data).toEqual({
      provider: 'gemini',
      hint: 'credential-sealed',
      did: PRINCIPAL,
      appDid: ACTING_APP,
    });
  });

  it('carries the pair on a delegated unseal', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: null });

    await notifyConnectorCredentialUnsealed(PRINCIPAL, 'gcp', ACTING_APP);

    expect(insertValues[0].data).toEqual({ provider: 'gcp', did: PRINCIPAL, appDid: ACTING_APP });
  });

  it('adds nothing at all when the owner acted first-party', async () => {
    await notifyConnectorModelsChanged(PRINCIPAL, 'openai', 'catalog-update');

    expect(insertValues[0].data).toEqual({ provider: 'openai', hint: 'catalog-update' });
  });
});

// ── Fail-open contract (#2205 acceptance: never fails the caller) ─────────

describe('fail-open contract', () => {
  it('swallows a DB insert failure — the caller never observes a rejection', async () => {
    insertMock.mockImplementationOnce(() => {
      throw new Error('relation "notify.notifications" does not exist');
    });
    getConnectorMock.mockReturnValue({ modelsRoute: '/gemini/api/models' });

    await expect(notifyConnectorCredentialSealed(PRINCIPAL, 'gemini')).resolves.toBeUndefined();
  });

  it('swallows a WS push failure — the caller never observes a rejection', async () => {
    pushMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    getConnectorMock.mockReturnValue({ modelsRoute: null });

    await expect(notifyConnectorCredentialUnsealed(PRINCIPAL, 'discord')).resolves.toBeUndefined();
  });

  it('a models.changed failure does not stop the credential-sealed row from having been written', async () => {
    getConnectorMock.mockReturnValue({ modelsRoute: '/gemini/api/models' });
    // The sealed-scope row succeeds; the second (models.changed) call's own
    // insert throws — emitConnectorNotification catches it internally.
    insertMock
      .mockImplementationOnce(() => ({ values: (v: Record<string, unknown>) => { insertValues.push(v); return Promise.resolve(); } }))
      .mockImplementationOnce(() => { throw new Error('boom'); });

    await expect(notifyConnectorCredentialSealed(PRINCIPAL, 'gemini')).resolves.toBeUndefined();
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0].scope).toBe(CONNECTOR_CREDENTIAL_SEALED_SCOPE);
  });
});
