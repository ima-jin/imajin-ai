/**
 * Anthropic BILLING connector wiring tests (#1076 Stage 1).
 *
 * Reuses the shared `createConnectorTokenPaste` mock factory from
 * `brain-connector-contract.ts` (the same mock-setup boilerplate every other
 * token-paste connector's test uses) rather than duplicating it, but asserts
 * its own scope contract directly instead of going through
 * `describeConnectorIdentityContract` — that helper hardcodes the `${id}:infer`
 * scope-naming convention, which does not fit a SECOND credential on the
 * same connector (`anthropic:billing`, not `anthropic-billing:infer`).
 */
import { describe, it, expect } from 'vitest';
import { mockConnectorTokenPasteFactory } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials } = mockConnectorTokenPasteFactory();

const {
  ANTHROPIC_CONNECTOR_DID,
  ANTHROPIC_CHANNEL,
  ANTHROPIC_BILLING_SCOPE,
  vaultField,
  loadAnthropicBillingCredentials,
} = await import('../billing-connector');

const OWNER = 'did:imajin:farmer';

describe('Anthropic billing connector identity', () => {
  it('names the anthropic:billing scope, distinct from anthropic:infer', () => {
    expect(ANTHROPIC_BILLING_SCOPE).toBe('anthropic:billing');
  });

  // did:imajin:anthropic-connector is the literal `connector.ts` (the
  // inference connector) declares — not re-imported here, since doing so
  // would call the mocked factory a second time and overwrite `capturedOpts`
  // below with THAT call's options instead of the billing connector's.
  it('shares the SAME connector DID and channel as the inference connector', () => {
    expect(ANTHROPIC_CONNECTOR_DID).toBe('did:imajin:anthropic-connector');
    expect(ANTHROPIC_CHANNEL).toBe('anthropic');
  });

  it('builds the factory with a distinct id so the sealed key lands in its own vault field', () => {
    expect(capturedOpts.current).toMatchObject({
      id: 'anthropic-billing',
      displayName: 'Anthropic Billing',
      connectorDid: ANTHROPIC_CONNECTOR_DID,
      channel: ANTHROPIC_CHANNEL,
    });
  });

  it('isolates the sealed billing key per DID, and away from the inference key field', () => {
    expect(vaultField(OWNER)).toBe(`anthropic-billing-api-key:${OWNER}`);
    expect(vaultField(OWNER)).not.toBe(`anthropic-api-key:${OWNER}`);
  });

  it('spends the admin key only behind an active anthropic:billing grant', async () => {
    loadCredentials.mockResolvedValueOnce({ apiKey: 'sk-ant-admin-sealed' });

    await loadAnthropicBillingCredentials(OWNER);

    expect(loadCredentials).toHaveBeenCalledWith(OWNER, ANTHROPIC_BILLING_SCOPE);
  });
});
