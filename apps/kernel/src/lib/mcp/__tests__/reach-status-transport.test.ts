import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocked = vi.hoisted(() => ({ jwt: vi.fn(), bearer: vi.fn(), status: vi.fn() }));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocked.jwt }));
vi.mock('@/src/lib/access/delegate-grant', () => ({ resolveDelegateGrantBearer: mocked.bearer }));
vi.mock('@/src/lib/auth/reach-status', () => ({ reachStatus: mocked.status }));
vi.mock('@/src/lib/mcp/mcp-grant', () => ({ resolveActiveMcpGrant: vi.fn() }));
vi.mock('@/src/lib/mcp/tools', async () => {
  const { reachStatusTool } = await import('../tools/reach');
  return { ALL_TOOLS: [reachStatusTool], toolByName: (name: string) => name === reachStatusTool.name ? reachStatusTool : undefined };
});

import { POST } from '@/app/mcp/route';
import { getMcpResource } from '../oauth-config';
import { reachStatusTool } from '../tools/reach';

const requesterDid = 'did:imajin:foreign';
const principalDid = 'did:imajin:ryan';
const reachId = 'reach_1';
const status = {
  reachId, state: 'replied',
  reply: { type: 'agent.reach.replied', issuer: principalDid, payload: { message: 'Reply', signature: { sig: 'proof' } } },
};

function call(args: Record<string, unknown> = { principalDid, reachId }) {
  return POST(new NextRequest('https://node.test/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer test-credential', 'x-acting-as': 'did:imajin:victim' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reach_status', arguments: args } }),
  }));
}

beforeEach(() => {
  mocked.jwt.mockReset().mockResolvedValue(null);
  mocked.bearer.mockReset().mockResolvedValue({ ok: false, reason: 'unknown' });
  mocked.status.mockReset().mockResolvedValue(status);
});

describe('reach_status through caller MCP transport', () => {
  it('returns the reply over OAuth using verified token sub, never arguments/act-as/app DID', async () => {
    mocked.jwt.mockResolvedValue({ sub: requesterDid, azp: 'did:imajin:client', aud: getMcpResource(), scope: 'discovery:read' });
    const response = await call({ principalDid, reachId, requesterDid: 'did:imajin:victim' });
    const result = await response.json();
    expect(JSON.parse(result.result.content[0].text)).toEqual(status);
    expect(mocked.status).toHaveBeenCalledWith({ principalDid, reachId, requesterDid });
  });

  it('returns the same reply over a scoped static bearer without an extra hand-issued read grant', async () => {
    mocked.bearer.mockResolvedValue({ ok: true, principalDid: requesterDid, bearerId: 'bearer_1', scopes: ['discovery:read'] });
    const result = await (await call()).json();
    expect(JSON.parse(result.result.content[0].text)).toEqual(status);
    expect(mocked.bearer).toHaveBeenCalledWith('test-credential', 'mcp');
    expect(mocked.status).toHaveBeenCalledWith({ principalDid, reachId, requesterDid });
  });

  it('does not let another authenticated caller enumerate a reply by id', async () => {
    mocked.jwt.mockResolvedValue({ sub: 'did:imajin:other', azp: 'app', aud: getMcpResource(), scope: 'discovery:read' });
    mocked.status.mockResolvedValue(null);
    const result = await (await call()).json();
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('Reach not found');
    expect(JSON.stringify(result)).not.toContain('proof');
  });

  it('denies anonymous, revoked bearer and wrong-audience OAuth credentials before reading', async () => {
    expect((await call()).status).toBe(401);
    mocked.bearer.mockResolvedValue({ ok: false, reason: 'expired' });
    expect((await call()).status).toBe(401);
    mocked.jwt.mockResolvedValue({ sub: requesterDid, azp: 'app', aud: 'https://other.test/mcp', scope: 'discovery:read' });
    expect((await call()).status).toBe(401);
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it.each([{}, { principalDid }, { reachId }])('requires the target and receipt: %j', async (args) => {
    await expect(reachStatusTool.handler(args, { did: requesterDid, appDid: 'app', scopes: new Set() }))
      .rejects.toThrow('principalDid and reachId are required');
    expect(mocked.status).not.toHaveBeenCalled();
  });
});
