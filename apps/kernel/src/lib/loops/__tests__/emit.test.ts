import { beforeEach, describe, expect, it, vi } from 'vitest';
const { identity, ingest, sign, canonicalize, log } = vi.hoisted(() => ({
  identity: vi.fn(), ingest: vi.fn(), sign: vi.fn(), canonicalize: vi.fn(JSON.stringify),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@imajin/auth', () => ({ canonicalize, crypto: { signSync: sign } }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: identity }));
vi.mock('../ingest', () => ({ ingestLoopEvent: ingest }));
import { emitKernelLoopEvent } from '../emit';

const payload = { loopId: 'native', kind: 'review', principal: 'did:imajin:owner', state: 'running', summary: 'Review started', at: '2026-10-16T00:00:00Z' };
beforeEach(() => {
  vi.clearAllMocks();
  identity.mockReturnValue({ senderDid: 'did:imajin:node', senderPubkey: 'AB', privateKeyHex: 'private' });
  sign.mockReturnValue('CD');
  ingest.mockResolvedValue({ ok: true });
});
describe('native loop witness', () => {
  it('signs the original envelope and uses node publisher with the real principal', async () => {
    await emitKernelLoopEvent('loop.started', payload);
    expect(canonicalize).toHaveBeenCalledWith({ type: 'loop.started', payload });
    expect(sign).toHaveBeenCalledWith(JSON.stringify({ type: 'loop.started', payload }), 'private');
    expect(ingest).toHaveBeenCalledWith({ type: 'loop.started', payload, publisherDid: 'did:imajin:node', signature: { keyId: 'ab', alg: 'ed25519', sig: 'cd' } });
  });
  it('logs a rejection without throwing', async () => {
    ingest.mockResolvedValue({ ok: false, error: 'denied' });
    await expect(emitKernelLoopEvent('loop.started', payload)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
  it('logs unavailable signing without throwing', async () => {
    identity.mockImplementation(() => { throw new Error('vault offline'); });
    await expect(emitKernelLoopEvent('loop.started', payload)).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
