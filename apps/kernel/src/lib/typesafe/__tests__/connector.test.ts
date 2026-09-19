/**
 * TypeSafe.ai connector identity tests (#2197).
 *
 * The custody mechanics themselves (fail-closed grant gate, v1/v2 field
 * split, pending-grant distinction) are the shared `createConnectorTokenPaste`
 * factory's and are covered once in
 * `src/lib/kernel/__tests__/connector-token-paste.test.ts` — this file pins
 * only TypeSafe's own IDENTITY wiring, the same way every other token-paste
 * connector's `connector.test.ts` does.
 *
 * Unlike the brain connectors (Gemini, xAI, OpenAI, ..., OpenRouter), the
 * `describeConnectorIdentityContract` shared contract in
 * `brain-connector-contract.ts` is not reused here: it hardcodes an
 * `${id}:infer` scope-naming assumption that does not hold for TypeSafe's
 * `typesafe:decide` scope (a SERVICE connector, not an inference connector —
 * see `../connector.ts`'s header).
 */
import { it, expect, describe } from 'vitest';
import {
  mockConnectorTokenPasteFactory,
  expectNoRawKeyLeak,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const typesafeConnectorModule = await import('../connector');
const {
  TYPESAFE_CONNECTOR_DID,
  TYPESAFE_CHANNEL,
  TYPESAFE_DECIDE_SCOPE,
  TYPESAFE_BASE_URL,
  vaultField,
  loadTypesafeCredentials,
  loadTypesafeSealedCredentials,
} = typesafeConnectorModule;

const OWNER = 'did:imajin:farmer';
const SAMPLE_KEY = 'ts-sealed-key';

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectNoRawKeyLeak's doc comment) so Sonar S2699 recognizes this file
// as containing a real assertion.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  expect(expectNoRawKeyLeak(typesafeConnectorModule)).toEqual([]);
});

describe('TypeSafe connector identity', () => {
  it('declares the DID, channel, and scope the grant gate matches on - a SERVICE scope, not :infer', () => {
    expect(TYPESAFE_CONNECTOR_DID).toBe('did:imajin:typesafe-connector');
    expect(TYPESAFE_CHANNEL).toBe('typesafe');
    expect(TYPESAFE_DECIDE_SCOPE).toBe('typesafe:decide');
  });

  it('builds the factory with the id that becomes the vault field prefix', () => {
    expect(capturedOpts.current).toMatchObject({
      id: 'typesafe',
      displayName: 'TypeSafe.ai',
      connectorDid: TYPESAFE_CONNECTOR_DID,
      channel: TYPESAFE_CHANNEL,
    });
  });

  it('isolates the sealed key per DID, and away from other connectors', () => {
    expect(vaultField(OWNER)).toBe(`typesafe-api-key:${OWNER}`);
    expect(vaultField(OWNER)).not.toBe(`openrouter-api-key:${OWNER}`);
    expect(vaultField('did:imajin:other')).not.toBe(vaultField(OWNER));
  });

  it('exports one TypeSafe.ai API base for every caller to share', () => {
    expect(TYPESAFE_BASE_URL).toBe('https://api.typesafe.ai');
  });
});

describe('credential resolution', () => {
  it('spends the key only behind an active typesafe:decide grant', async () => {
    loadCredentials.mockResolvedValueOnce({ apiKey: SAMPLE_KEY });

    await loadTypesafeCredentials(OWNER);

    expect(loadCredentials).toHaveBeenCalledWith(OWNER, TYPESAFE_DECIDE_SCOPE);
  });

  /**
   * GET /typesafe/api/models is the connect-time key-validation probe and
   * card status read (#1773 precedent) - it must not require the
   * typesafe:decide grant, and the grant-checked path must not quietly
   * become this one.
   */
  it('reserves the grant-skipping read for GET /typesafe/api/models', async () => {
    loadSealedCredentials.mockResolvedValueOnce({ apiKey: SAMPLE_KEY });

    await loadTypesafeSealedCredentials(OWNER);

    expect(loadSealedCredentials).toHaveBeenCalledWith(OWNER);
    expect(loadSealedCredentials).not.toHaveBeenCalledWith(OWNER, TYPESAFE_DECIDE_SCOPE);
  });
});
