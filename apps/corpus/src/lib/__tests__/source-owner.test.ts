import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCorpusDid } from '../source-owner';
import { getAttestationInternalApiKey, markAttestationKeyUsedForForwarding } from '../attestation-key';
vi.mock('../attestation-key', () => ({
  getAttestationInternalApiKey: vi.fn(), markAttestationKeyUsedForForwarding: vi.fn(),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AUTH_SERVICE_URL', 'http://identity.test/auth');
  vi.mocked(getAttestationInternalApiKey).mockReturnValue('fixture-internal-credential');
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('corpus identity service lookup', () => {
  it('uses the identity service rather than the calling DID or a hardcoded org DID', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ did: 'did:imajin:resolved-group' }) });
    expect(await resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).toBe('did:imajin:resolved-group');
    expect(fetchMock).toHaveBeenCalledWith('http://identity.test/auth/api/internal/corpus/owner', expect.objectContaining({
      body: JSON.stringify({ source: 'github:ima-jin/imajin-ai', principalDid: 'did:imajin:jin' }), redirect: 'error',
    }));
    expect(markAttestationKeyUsedForForwarding).toHaveBeenCalled();
  });
  it('does not call the identity service for personal workspace sources', async () => {
    expect(await resolveCorpusDid('local:workspace', 'did:imajin:ryan')).toBe('did:imajin:ryan');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([null, ''])('fails closed when the vault key is unavailable (%s)', async key => {
    vi.mocked(getAttestationInternalApiKey).mockReturnValue(key);
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed when the identity endpoint is not configured', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', '');
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow('not configured');
  });
  it.each([{ ok: false }, { ok: true, json: async () => ({ did: '@jin' }) }, { ok: true, json: async () => ({}) }])('rejects unavailable or invalid identity responses', async response => {
    fetchMock.mockResolvedValue(response);
    await expect(resolveCorpusDid('github:ima-jin/imajin-ai', 'did:imajin:jin')).rejects.toThrow();
    expect(markAttestationKeyUsedForForwarding).not.toHaveBeenCalled();
  });
});
