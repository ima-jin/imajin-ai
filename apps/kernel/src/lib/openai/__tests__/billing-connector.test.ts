/**
 * OpenAI BILLING connector wiring tests (#1076 Stage 1). See
 * `@/src/lib/anthropic/__tests__/billing-connector.test.ts` for the full
 * rationale; this is the OpenAI instance of the identical contract.
 */
import { describe, it, expect } from 'vitest';
import { mockConnectorTokenPasteFactory } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials } = mockConnectorTokenPasteFactory();

const {
  OPENAI_CONNECTOR_DID,
  OPENAI_CHANNEL,
  OPENAI_BILLING_SCOPE,
  vaultField,
  loadOpenaiBillingCredentials,
} = await import('../billing-connector');

const OWNER = 'did:imajin:farmer';

describe('OpenAI billing connector identity', () => {
  it('names the openai:billing scope, distinct from openai:infer', () => {
    expect(OPENAI_BILLING_SCOPE).toBe('openai:billing');
  });

  it('shares the SAME connector DID and channel as the inference connector', () => {
    expect(OPENAI_CONNECTOR_DID).toBe('did:imajin:openai-connector');
    expect(OPENAI_CHANNEL).toBe('openai');
  });

  it('builds the factory with a distinct id so the sealed key lands in its own vault field', () => {
    expect(capturedOpts.current).toMatchObject({
      id: 'openai-billing',
      displayName: 'OpenAI Billing',
      connectorDid: OPENAI_CONNECTOR_DID,
      channel: OPENAI_CHANNEL,
    });
  });

  it('isolates the sealed billing key per DID, and away from the inference key field', () => {
    expect(vaultField(OWNER)).toBe(`openai-billing-api-key:${OWNER}`);
    expect(vaultField(OWNER)).not.toBe(`openai-api-key:${OWNER}`);
  });

  it('spends the admin key only behind an active openai:billing grant', async () => {
    loadCredentials.mockResolvedValueOnce({ apiKey: 'sk-admin-sealed' });

    await loadOpenaiBillingCredentials(OWNER);

    expect(loadCredentials).toHaveBeenCalledWith(OWNER, OPENAI_BILLING_SCOPE);
  });
});
