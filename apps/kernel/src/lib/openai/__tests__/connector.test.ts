/**
 * OpenAI connector wiring tests (#1927).
 *
 * The custody mechanics are the token-paste factory's, and are covered once in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` — re-testing them per
 * provider would test the factory four times and the connector zero. What is
 * specific to this module, and what this pins, is IDENTITY: the connector id
 * (which becomes the vault field prefix), the channel and app DID the grant
 * gate matches on, the scope spent at call time, and the fact that the
 * grant-skipping read is reserved for the model picker.
 *
 * Getting any of those wrong is silent: the key seals fine and inference just
 * never resolves, or — worse — resolves against another provider's field.
 */
import { describe, it, expect, vi } from 'vitest';

const { capturedOpts, factoryStub, loadCredentials, loadSealedCredentials } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  factoryStub: {} as Record<string, unknown>,
  loadCredentials: vi.fn(),
  loadSealedCredentials: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-token-paste', () => ({
  createConnectorTokenPaste: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    Object.assign(factoryStub, {
      vaultField: (did: string) => `${opts.id as string}-api-key:${did}`,
      sealApiKey: vi.fn(),
      resolveActiveGrant: vi.fn(),
      requireGrantAndKey: vi.fn(),
      keySealed: vi.fn(),
      keyPending: vi.fn(),
      revokeApiKey: vi.fn(),
      setModelId: vi.fn(),
      loadCredentials,
      loadSealedCredentials,
    });
    return factoryStub;
  }),
}));

import {
  OPENAI_CONNECTOR_DID,
  OPENAI_CHANNEL,
  OPENAI_INFER_SCOPE,
  OPENAI_BASE_URL,
  vaultField,
  loadOpenaiCredentials,
  loadOpenaiSealedCredentials,
} from '../connector';

const OWNER = 'did:imajin:farmer';

describe('OpenAI connector identity', () => {
  it('declares the DID, channel and scope the grant gate matches on', () => {
    expect(OPENAI_CONNECTOR_DID).toBe('did:imajin:openai-connector');
    expect(OPENAI_CHANNEL).toBe('openai');
    expect(OPENAI_INFER_SCOPE).toBe('openai:infer');
  });

  it('builds the factory with the id that becomes the vault field prefix', () => {
    expect(capturedOpts.current).toMatchObject({
      id: 'openai',
      displayName: 'OpenAI',
      connectorDid: 'did:imajin:openai-connector',
      channel: 'openai',
    });
  });

  it('isolates the sealed key per DID, and away from the other brains', () => {
    expect(vaultField(OWNER)).toBe(`openai-api-key:${OWNER}`);
    expect(vaultField(OWNER)).not.toBe(`gemini-api-key:${OWNER}`);
    expect(vaultField('did:imajin:other')).not.toBe(vaultField(OWNER));
  });

  /**
   * The brain entry's `defaultBaseUrl` and the model-picker route both read
   * this. Two copies of a provider endpoint is how one of them ends up
   * pointing somewhere retired.
   */
  it('exports one OpenAI endpoint for every caller to share', () => {
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
  });
});

describe('credential resolution', () => {
  it('spends the key only behind an active openai:infer grant', async () => {
    loadCredentials.mockResolvedValueOnce({ apiKey: 'sk-SEALED' });

    await loadOpenaiCredentials(OWNER);

    expect(loadCredentials).toHaveBeenCalledWith(OWNER, 'openai:infer');
  });

  /**
   * #1773: the picker asks "what can the owner's own key do?", which the owner
   * asks before the grant step exists. It must NOT be reachable through the
   * grant-checked path, and the grant-checked path must not quietly become
   * this one.
   */
  it('reserves the grant-skipping read for the model picker', async () => {
    loadSealedCredentials.mockResolvedValueOnce({ apiKey: 'sk-SEALED' });

    await loadOpenaiSealedCredentials(OWNER);

    expect(loadSealedCredentials).toHaveBeenCalledWith(OWNER);
    expect(loadSealedCredentials).not.toHaveBeenCalledWith(OWNER, 'openai:infer');
  });
});
