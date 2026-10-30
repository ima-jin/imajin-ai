// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { canonicalCommandJson, dispatchSessionCommand, prepareSignedSessionCommand } from '../session-command-client';

const body = {
  type: 'session.send', commandId: 'command', to: 'did:agent', principal: 'did:principal', issuer: 'did:kernel',
  issuedAt: '2026-10-17T12:00:00.000Z', expiresAt: '2026-10-17T12:05:00.000Z',
  payload: { loopId: 'loop', message: 'signed wish' },
};
const frame = { ...body, signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) } };
const respond = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value });
let publicKey: Uint8Array;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  publicKey = await ed.getPublicKeyAsync(new Uint8Array(32).fill(1));
  localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: '01'.repeat(32), publicKey: ed.etc.bytesToHex(publicKey) }));
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe('principal command wish', () => {
  it.each([undefined, null])('signs null-canonical expiry for plugin-compatible expiry=%s', async expiresAt => {
    const commandBody = { ...body, type: 'session.history' as const, expiresAt, payload: { loopId: 'loop' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ command: { ...frame, ...commandBody } })));
    const command = await prepareSignedSessionCommand('loop', 'session.history', commandBody.payload);
    expect(await ed.verifyAsync(ed.etc.hexToBytes(command.countersignature!.sig),
      new TextEncoder().encode(canonicalCommandJson({ ...commandBody, expiresAt: null })), publicKey)).toBe(true);
  });
  it('signs the exact full canonical body, excluding grant and wish signatures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ command: frame })));
    const command = await prepareSignedSessionCommand('loop', 'session.send', body.payload);
    expect(await ed.verifyAsync(ed.etc.hexToBytes(command.countersignature!.sig), new TextEncoder().encode(canonicalCommandJson(body)), publicKey)).toBe(true);
    expect(await ed.verifyAsync(ed.etc.hexToBytes(command.countersignature!.sig), new TextEncoder().encode(canonicalCommandJson({ ...body, to: 'did:other' })), publicKey)).toBe(false);
    expect(command.signature).toEqual(frame.signature);
    expect(canonicalCommandJson({ z: [true, null, { b: 1, a: 'x' }], a: false })).toBe('{"a":false,"z":[true,null,{"a":"x","b":1}]}');
  });

  it.each([null, '{', '{}', '{"privateKey":"bad","publicKey":"bad"}'])('rejects missing/malformed local keys %s before preparing', async (stored) => {
    localStorage.clear();
    if (stored) localStorage.setItem('imajin_keypair', stored);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(prepareSignedSessionCommand('loop', 'session.send', body.payload)).rejects.toThrow('signing key');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500])('rejects HTTP %s explicitly', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({}, status)));
    await expect(prepareSignedSessionCommand('loop', 'session.send', body.payload)).rejects.toThrow(status === 500 ? 'No execution confirmed' : 'Authorization changed');
  });

  it.each([{ ...frame, type: 'session.abort' }, { ...frame, payload: { loopId: 'other', message: 'signed wish' } }])('refuses to sign an altered prepared wish', async (command) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ command })));
    await expect(prepareSignedSessionCommand('loop', 'session.send', body.payload)).rejects.toThrow('does not match');
  });

  it('dispatches without treating delivery as completion and preserves network errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond({ commandId: 'command', delivered: false }));
    vi.stubGlobal('fetch', fetcher);
    const result = await dispatchSessionCommand('a/b', frame as Parameters<typeof dispatchSessionCommand>[1]);
    expect(result).toEqual({ commandId: 'command', delivered: false });
    expect(fetcher.mock.calls[0][0]).toBe('/jin/api/runs/a%2Fb/commands');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'dispatch', command: frame });
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(dispatchSessionCommand('loop', frame as Parameters<typeof dispatchSessionCommand>[1])).rejects.toThrow('offline');
  });
});
