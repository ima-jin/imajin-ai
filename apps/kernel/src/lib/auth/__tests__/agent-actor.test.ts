import { describe, it, expect } from 'vitest';
import { agentSentinelKey, buildAgentActorRow } from '../agent-actor';

describe('agentSentinelKey', () => {
  it('derives a deterministic, non-curve agent_ sentinel from the app id', () => {
    expect(agentSentinelKey('app_claude_desktop')).toBe('agent_app_claude_desktop');
    expect(agentSentinelKey('app_x')).toBe('agent_app_x');
  });
});

describe('buildAgentActorRow', () => {
  it('mirrors migration 0053: actor/agent, sentinel key, NULL handle, agent metadata', () => {
    const row = buildAgentActorRow({
      appId: 'app_claude_desktop',
      appDid: 'did:imajin:claude-desktop',
      name: 'Claude Desktop',
    });

    expect(row).toEqual({
      id: 'did:imajin:claude-desktop',
      scope: 'actor',
      subtype: 'agent',
      publicKey: 'agent_app_claude_desktop',
      handle: null,
      name: 'Claude Desktop',
      avatarUrl: null,
      metadata: {
        agent: true,
        client: true,
        adapter: 'oauth',
        adapterAppId: 'app_claude_desktop',
      },
    });
  });

  it('defaults adapter to oauth and records the override when provided', () => {
    expect(buildAgentActorRow({ appId: 'a', appDid: 'd' }).metadata.adapter).toBe('oauth');
    expect(
      buildAgentActorRow({ appId: 'a', appDid: 'd', adapter: 'keypair' }).metadata.adapter,
    ).toBe('keypair');
  });

  it('uses NULL handle and NULL name/avatar when not supplied', () => {
    const row = buildAgentActorRow({ appId: 'app_x', appDid: 'did:imajin:x' });
    expect(row.handle).toBeNull();
    expect(row.name).toBeNull();
    expect(row.avatarUrl).toBeNull();
  });

  it('keeps the actor DID (appDid) as the identity id, never the appId', () => {
    const row = buildAgentActorRow({ appId: 'app_x', appDid: 'did:imajin:x' });
    expect(row.id).toBe('did:imajin:x');
    expect(row.publicKey).toBe('agent_app_x');
  });
});
