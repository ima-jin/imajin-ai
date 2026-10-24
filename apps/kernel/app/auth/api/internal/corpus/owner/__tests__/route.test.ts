import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
import { resolveCorpusDid } from '@/src/lib/kernel/corpus-owner';
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: vi.fn() }));
vi.mock('@/src/lib/kernel/corpus-owner', () => ({ resolveCorpusDid: vi.fn() }));
function request(body: string) {
  return new NextRequest('http://kernel.test/auth/api/internal/corpus/owner', { method: 'POST', body });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireInternalApiKey).mockResolvedValue(null);
  vi.mocked(resolveCorpusDid).mockResolvedValue('did:imajin:org');
});
describe('internal corpus identity resolver', () => {
  it('requires the existing vault-backed service credential', async () => {
    vi.mocked(requireInternalApiKey).mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await POST(request('{}'))).status).toBe(401);
    expect(resolveCorpusDid).not.toHaveBeenCalled();
  });
  it.each(['{', 'null', '{}', '{"source":42,"principalDid":"did:imajin:jin"}', '{"source":"github:ima-jin/imajin-ai","principalDid":""}'])('rejects invalid request %s', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(resolveCorpusDid).not.toHaveBeenCalled();
  });
  it('returns only the resolved group DID without granting access', async () => {
    const response = await POST(request(JSON.stringify({ source: 'github:ima-jin/imajin-ai', principalDid: 'did:imajin:jin' })));
    expect(await response.json()).toEqual({ did: 'did:imajin:org' });
    expect(resolveCorpusDid).toHaveBeenCalledWith('github:ima-jin/imajin-ai', 'did:imajin:jin');
  });
  it('fails closed and hides identity provider diagnostics', async () => {
    vi.mocked(resolveCorpusDid).mockRejectedValue(new Error('private diagnostic'));
    const response = await POST(request('{"source":"github:ima-jin/imajin-ai","principalDid":"did:imajin:jin"}'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Corpus owner resolution unavailable' });
  });
});
