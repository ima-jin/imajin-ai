import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runAnthropicSmoke } from '../artifact-org-bot-smoke.mjs';

const agentDid = 'did:imajin:artifact-agent';
const orgDid = 'did:imajin:artifact';
function input(claims = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    agentDid, orgDid, model: 'claude-test', auditToken: randomUUID(),
    agentToken: `${encode({ typ: 'app+jwt', alg: 'EdDSA' })}.${encode({
      azp: agentDid, sub: agentDid, exp: Date.now() / 1000 + 600, aud: 'imajin:apps', ...claims,
    })}.${encode(randomUUID())}`,
  };
}
function fixture() {
  const route = {
    kind: 'A', usable: true, billedPrincipal: { did: orgDid, handle: 'artifact' },
    card: { provider: 'anthropic' }, selectors: { actingAs: orgDid }, selectedModels: ['claude-test'],
  };
  const audit = { principalDid: orgDid, turns: [{ usage: [{
    id: 'usage_proof', source: 'inference-passthrough', provider: 'anthropic',
    agentDid, externalId: 'msg_proof', status: null,
  }] }] };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ routes: [route] }))
    .mockResolvedValueOnce(Response.json({ id: 'msg_proof', content: 'not printed' }))
    .mockImplementation(async () => Response.json(audit));
  return { route, audit, fetcher, sleep: vi.fn() };
}
describe('Artifact org bot operator Anthropic smoke', () => {
  it('dry-runs with no credentials, network or live billing claim', async () => {
    const fetcher = vi.fn();
    expect(await runAnthropicSmoke(undefined, { dryRun: true, fetcher }))
      .toEqual({ status: 'dry-run', billedOrg: null, usageIds: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('prints only verified billing metadata and correlates a real usage ID, not the message ID', async () => {
    const config = input();
    const deps = fixture();
    const result = await runAnthropicSmoke(config, deps);
    expect(result).toEqual({ status: 'passed', billedOrg: 'artifact', usageIds: ['usage_proof'] });
    const calls = deps.fetcher.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][0]).toBe('http://127.0.0.1:8787/anthropic/v1/messages');
    expect(calls[1][1].headers).toMatchObject({
      Authorization: `Bearer ${config.agentToken}`, 'x-acting-as': orgDid,
    });
    expect(calls[1][1].headers).not.toHaveProperty('x-acting-for');
    expect(calls[2][1].headers.Authorization).toBe(`Bearer ${config.auditToken}`);
    expect(calls[2][0]).toContain(calls[1][1].headers['x-imajin-session']);
    for (const [, init] of calls) expect(init.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toContain(config.agentToken);
    expect(JSON.stringify(result)).not.toContain(config.auditToken);
  });
  it.each([
    { sub: orgDid }, { azp: orgDid }, { exp: 0 }, { exp: 'later' }, { aud: 'different' },
  ])('refuses invalid caller claims before dispatch: %j', async claims => {
    const deps = fixture();
    await expect(runAnthropicSmoke(input(claims), deps)).rejects.toThrow();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });
  it.each(['agentDid', 'orgDid', 'model', 'auditToken', 'agentToken'])('requires %s', async field => {
    const config = input();
    config[field] = '';
    const deps = fixture();
    await expect(runAnthropicSmoke(config, deps)).rejects.toThrow();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { agentDid: 'not-a-did' }, { orgDid: 'not-a-did' },
    { model: ' ' }, { auditToken: ' ' }, { agentToken: 'not-a-jwt' },
    { agentToken: 'a.b.c.d' }, { agentToken: 'e30.e30.c2ln' },
  ])('refuses malformed input before dispatch (case %#)', async invalid => {
    const deps = fixture();
    await expect(runAnthropicSmoke({ ...input(), ...invalid }, deps)).rejects.toThrow();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });
  it.each(['human-route', 'unusable', 'wrong-org', 'wrong-handle', 'acting-for', 'wrong-provider', 'wrong-model'])(
    'refuses %s discovery without sending a billed call', async boundary => {
      const deps = fixture();
      if (boundary === 'human-route') deps.route.kind = 'C';
      if (boundary === 'unusable') deps.route.usable = false;
      if (boundary === 'wrong-org') deps.route.billedPrincipal.did = agentDid;
      if (boundary === 'wrong-handle') deps.route.billedPrincipal.handle = 'personal';
      if (boundary === 'acting-for') deps.route.selectors.actingFor = agentDid;
      if (boundary === 'wrong-provider') deps.route.card.provider = 'warp';
      if (boundary === 'wrong-model') deps.route.selectedModels = [];
      deps.fetcher.mockReset().mockResolvedValue(Response.json({ routes: [deps.route] }));
      await expect(runAnthropicSmoke(input(), deps)).rejects.toThrow();
      expect(deps.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['wrong-principal', 'wrong-agent', 'wrong-message', 'error-row', 'unsafe-id', 'missing-row'])(
    'does not claim billing from %s audit data', async boundary => {
      const deps = fixture();
      const row = deps.audit.turns[0].usage[0];
      if (boundary === 'wrong-principal') deps.audit.principalDid = agentDid;
      if (boundary === 'wrong-agent') row.agentDid = orgDid;
      if (boundary === 'wrong-message') row.externalId = 'another-message';
      if (boundary === 'error-row') row.status = 'error';
      if (boundary === 'unsafe-id') row.id = 'not an id\nresponse body';
      if (boundary === 'missing-row') deps.audit.turns = [];
      await expect(runAnthropicSmoke(input(), deps)).rejects.toThrow('Org bot smoke failed');
    },
  );
  it('refuses HTTP errors without returning upstream bodies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(randomUUID(), { status: 403 }));
    await expect(runAnthropicSmoke(input(), { fetcher })).rejects.toThrow('Org bot smoke failed');
  });
  it('has a safe CLI dry-run and never prints invalid stdin or exceptions', () => {
    const path = fileURLToPath(new URL('../artifact-org-bot-smoke.mjs', import.meta.url));
    const dry = spawnSync(process.execPath, [path, '--dry-run'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toEqual({ status: 'dry-run', billedOrg: null, usageIds: [] });
    const invalid = spawnSync(process.execPath, [path], { encoding: 'utf8', input: randomUUID() });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toEqual({ status: 'failed', billedOrg: null, usageIds: [] });
    expect(invalid.stderr).toBe('');
  });
});
