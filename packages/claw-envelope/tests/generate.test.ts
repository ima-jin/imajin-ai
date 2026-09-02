import { describe, expect, it } from 'vitest';
import { generateEnvelope, validateIntentScopes } from '../src/generate.js';
import type { ContextEnvelopeInput } from '../src/types.js';

const baseInput: ContextEnvelopeInput = {
  agentDid: 'did:imajin:agent-nanoclaw-poc',
  ownerDid: 'did:imajin:owner-ryan',
  handle: 'nanoclaw-poc',
  intent: {
    scopes: ['messages:read', 'messages:write'],
    busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch.' }],
    brain: { placement: 'hosted', provider: 'anthropic:claude', deviation: 'direct key POC' },
    purpose: 'First hand-built NanoClaw instance.',
  },
};

describe('validateIntentScopes', () => {
  it('splits known and unknown scopes', () => {
    const result = validateIntentScopes(['messages:read', 'not-a-real-scope']);
    expect(result.valid).toEqual(['messages:read']);
    expect(result.invalid).toEqual(['not-a-real-scope']);
  });

  it('accepts every scope in the closed registry', () => {
    const result = validateIntentScopes(['messages:read', 'messages:write', 'discovery:read']);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(3);
  });
});

describe('generateEnvelope', () => {
  it('produces a harness-agnostic envelope with the requested identity and scopes', () => {
    const envelope = generateEnvelope(baseInput);
    expect(envelope.agentDid).toBe(baseInput.agentDid);
    expect(envelope.ownerDid).toBe(baseInput.ownerDid);
    expect(envelope.handle).toBe('nanoclaw-poc');
    expect(envelope.delegationGrants.map((g) => g.capability)).toEqual(['messages:read', 'messages:write']);
    expect(envelope.config.mcp.scopes).toEqual(['messages:read', 'messages:write']);
    expect(envelope.busRoutes).toEqual(baseInput.intent.busRoutes);
  });

  it('never carries raw secret values — only vault-field or env-var references', () => {
    const envelope = generateEnvelope(baseInput);
    for (const secret of envelope.secrets) {
      expect(['vault-field', 'env-var']).toContain(secret.kind);
      expect(typeof secret.name).toBe('string');
      // Type-level guarantee: SecretRef has no value/secret/key field to assert on directly,
      // but at minimum every ref must resolve to a symbolic name, never something secret-shaped.
      expect(secret.name.length).toBeGreaterThan(0);
    }
  });

  it('surfaces a brain deviation in both config and a dedicated secret entry', () => {
    const envelope = generateEnvelope(baseInput);
    expect(envelope.config.model.deviation).toBe('direct key POC');
    expect(envelope.secrets.some((s) => s.name === 'DIRECT_BRAIN_API_KEY')).toBe(true);
  });

  it('throws on an unknown grant capability rather than silently dropping it', () => {
    const badInput: ContextEnvelopeInput = {
      ...baseInput,
      intent: { ...baseInput.intent, scopes: ['messages:read', 'totally-made-up:scope'] },
    };
    expect(() => generateEnvelope(badInput)).toThrow(/Unknown grant capabilities/);
  });

  it('includes the workspace file skeleton with identity and grants embedded', () => {
    const envelope = generateEnvelope(baseInput);
    expect(envelope.workspace['SOUL.md']).toContain('First hand-built NanoClaw instance');
    expect(envelope.workspace['AGENTS.md']).toContain(baseInput.agentDid);
    expect(envelope.workspace['AGENTS.md']).toContain('messages:read');
    expect(envelope.workspace['MEMORY.md']).toContain('nanoclaw-poc');
  });
});
