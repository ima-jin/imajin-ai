import { describe, it, expect } from 'vitest';
import { buildAgentActorRow, buildAgentMembershipRows } from '../agent-actor';

describe('buildAgentActorRow (#1735)', () => {
  it('stores the app’s real Ed25519 public key, not a label/sentinel string', () => {
    const row = buildAgentActorRow({
      appId: 'app_claude_desktop',
      appDid: 'did:imajin:claude-desktop',
      publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
      ownerDid: 'did:imajin:owner',
      name: 'Claude Desktop',
    });

    expect(row).toEqual({
      id: 'did:imajin:claude-desktop',
      scope: 'actor',
      subtype: 'agent',
      publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
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

  it('never falls back to an agent_<appId> sentinel', () => {
    // Regression for #1735: the old implementation derived `agent_${appId}`
    // internally and ignored whatever key was passed in. Assert the row uses
    // exactly the provided key.
    const row = buildAgentActorRow({
      appId: 'app_x',
      appDid: 'did:imajin:x',
      publicKey: 'deadbeef',
      ownerDid: 'did:imajin:owner',
    });
    expect(row.publicKey).toBe('deadbeef');
    expect(row.publicKey).not.toMatch(/^agent_/);
  });

  it('defaults adapter to oauth and records the override when provided', () => {
    const base = { appId: 'a', appDid: 'd', publicKey: 'pk', ownerDid: 'o' };
    expect(buildAgentActorRow(base).metadata.adapter).toBe('oauth');
    expect(buildAgentActorRow({ ...base, adapter: 'keypair' }).metadata.adapter).toBe('keypair');
  });

  it('uses NULL handle and NULL name/avatar when not supplied', () => {
    const row = buildAgentActorRow({
      appId: 'app_x',
      appDid: 'did:imajin:x',
      publicKey: 'pk',
      ownerDid: 'o',
    });
    expect(row.handle).toBeNull();
    expect(row.name).toBeNull();
    expect(row.avatarUrl).toBeNull();
  });

  it('keeps the actor DID (appDid) as the identity id, never the appId', () => {
    const row = buildAgentActorRow({
      appId: 'app_x',
      appDid: 'did:imajin:x',
      publicKey: 'pk',
      ownerDid: 'o',
    });
    expect(row.id).toBe('did:imajin:x');
  });
});

describe('buildAgentMembershipRows (#1735)', () => {
  const input = {
    appId: 'app_4MbCYrndTWiJjMPe',
    appDid: 'did:imajin:wjLjV7nSWNZLTUqnhKRUiBrnGG8mKK7q9WXpNEnV2SM',
    publicKey: 'pk',
    ownerDid: 'did:imajin:agrifortress',
    name: 'AgriFortress App',
  };

  it('produces exactly two rows: agent owned by the granting DID, and the reverse delegation', () => {
    const rows = buildAgentMembershipRows(input);
    expect(rows).toHaveLength(2);

    const ownerRow = rows.find(r => r.role === 'owner');
    expect(ownerRow).toEqual({
      identityDid: input.appDid,
      memberDid: input.ownerDid,
      role: 'owner',
      addedBy: input.ownerDid,
      addedVia: 'direct',
    });

    const agentRow = rows.find(r => r.role === 'agent');
    expect(agentRow).toEqual({
      identityDid: input.ownerDid,
      memberDid: input.appDid,
      role: 'agent',
      addedBy: input.ownerDid,
      addedVia: 'agent',
    });
  });

  it('never leaves the promoted actor as an orphan because both directions reference each other', () => {
    const [ownerRow, agentRow] = buildAgentMembershipRows(input);
    expect(ownerRow.identityDid).toBe(agentRow.memberDid);
    expect(ownerRow.memberDid).toBe(agentRow.identityDid);
  });
});
