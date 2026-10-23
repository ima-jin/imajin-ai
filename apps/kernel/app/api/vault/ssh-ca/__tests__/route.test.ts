import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const h = vi.hoisted(() => ({
  authority: vi.fn(), mint: vi.fn(), revoke: vi.fn(), trusted: vi.fn(),
}));
vi.mock('@/src/lib/vault/mint-authority', () => ({ requireMintAuthority: h.authority }));
vi.mock('@/src/lib/vault/ssh-ca', async original => ({
  ...await original<typeof import('@/src/lib/vault/ssh-ca')>(),
  mintSshCa: h.mint, revokeSshCa: h.revoke, trustedSshCaKeys: h.trusted,
}));
// Keep these cheap route tests independent of the real custody graph.
vi.mock('@/src/db', () => ({ db: {}, attestations: {}, vaultMintedKeys: {} }));
vi.mock('@/src/lib/vault/index', () => ({ revokeStaticSecretGrant: vi.fn() }));
vi.mock('@/src/lib/vault/mint', () => ({ mintKeypair: vi.fn() }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: vi.fn(), isVaultTier1: vi.fn() }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: vi.fn() }));

import { POST as mint } from '../route';
import { POST as rotate } from '../rotate/route';
import { POST as revoke } from '../revoke/route';
import { GET } from '../trusted-keys/route';
import { SshCaError } from '@/src/lib/vault/ssh-ca';
import { isSshCaPurpose, SSH_CA_DEFAULT_CERT_TTL_SECONDS, SSH_CA_MAX_CERT_TTL_SECONDS } from '@/src/lib/vault/ssh-ca-policy';

const authority = { actingDid: 'did:imajin:node', composedBy: 'did:imajin:delegate' };
const ca = { caId: 'vmk_test', purpose: 'deploy', publicKey: 'public-only', fingerprint: 'SHA256:public', status: 'active' };
const actions = [
  { name: 'mint', handler: mint, body: { purpose: 'deploy' } },
  { name: 'rotate', handler: rotate, body: { purpose: 'deploy' } },
  { name: 'revoke', handler: revoke, body: { purpose: 'deploy', caId: 'vmk_test' } },
];
function request(body: unknown) {
  return new Request('https://kernel.test/api/vault/ssh-ca', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.authority.mockResolvedValue({ ok: true, authority });
  h.mint.mockResolvedValue(ca);
  h.revoke.mockResolvedValue({ caId: 'vmk_test', alreadyRevoked: false });
  h.trusted.mockResolvedValue('public-only\n');
});

describe.each(actions)('$name SSH CA route', ({ name, handler, body }) => {
  it.each([401, 403])('refuses authority failure %s before invoking custody', async status => {
    h.authority.mockResolvedValue({ ok: false, response: new Response('{}', { status }) });
    expect((await handler(request(body))).status).toBe(status);
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });
  it.each([null, [], 'deploy', {}, { purpose: 1 }, { purpose: '' }, { purpose: 'Deploy' },
    { purpose: 'a\nbad' }, { purpose: 'a'.repeat(65) }, { purpose: ' deploy ' },
    { purpose: 'deploy', requesterDid: 'did:imajin:other' }, { purpose: 'deploy', privateKey: 'not-accepted' },
  ])('refuses invalid body %#', async invalid => {
    expect((await handler(request(invalid))).status).toBe(400);
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });
  it('refuses malformed JSON', async () => {
    expect((await handler(new Request('https://kernel.test', { method: 'POST', body: '{' }))).status).toBe(400);
  });
  it('passes only validated identifiers and resolved authority', async () => {
    const response = await handler(request(body));
    expect(response.status).toBe(name === 'revoke' ? 200 : 201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (name === 'revoke') expect(h.revoke).toHaveBeenCalledWith('deploy', 'vmk_test', authority);
    else expect(h.mint).toHaveBeenCalledWith('deploy', authority, name === 'rotate');
  });
  it('redacts upstream secret-bearing failures without logging', async () => {
    const seed = randomBytes(32).toString('hex');
    h.mint.mockRejectedValue(new Error(seed));
    h.revoke.mockRejectedValue(new Error(seed));
    const response = await handler(request(body));
    expect(response.status).toBe(503);
    expect((await response.text()).includes(seed)).toBe(false);
  });
  it.each([404, 409])('returns controlled lifecycle status %s', async status => {
    const error = new SshCaError(status, 'CA lifecycle refusal');
    h.mint.mockRejectedValue(error);
    h.revoke.mockRejectedValue(error);
    expect((await handler(request(body))).status).toBe(status);
  });
});

it.each([undefined, '', 'not-a-mint', 1, 'vmk_', 'vmk_bad\nid', `vmk_${'a'.repeat(101)}`])('refuses invalid revoke id %#', async caId => {
  expect((await revoke(request({ purpose: 'deploy', caId }))).status).toBe(400);
  expect(h.revoke).not.toHaveBeenCalled();
});

describe('public CA trust route', () => {
  it('returns anonymous plain text with no cache and never invokes authority', async () => {
    const response = await GET(new Request('https://kernel.test/trusted-keys?purpose=deploy'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('public-only\n');
    expect(h.authority).not.toHaveBeenCalled();
  });
  it.each(['', '?purpose=', '?purpose=Deploy', `?purpose=${'a'.repeat(65)}`, '?purpose=a%0Ab'])('refuses invalid query %s', async query => {
    expect((await GET(new Request(`https://kernel.test/trusted-keys${query}`))).status).toBe(400);
    expect(h.trusted).not.toHaveBeenCalled();
  });
  it('contains storage/retirement failures', async () => {
    const seed = randomBytes(32).toString('hex');
    h.trusted.mockRejectedValue(new Error(seed));
    const response = await GET(new Request('https://kernel.test/trusted-keys?purpose=deploy'));
    expect(response.status).toBe(503);
    expect((await response.text()).includes(seed)).toBe(false);
  });
});

it('exports a short default and bounded maximum for phase 2', () => {
  expect(SSH_CA_DEFAULT_CERT_TTL_SECONDS).toBe(600);
  expect(SSH_CA_MAX_CERT_TTL_SECONDS).toBe(900);
  for (const purpose of ['deploy', 'a', 'a'.repeat(64), 'deploy.host_1-2']) expect(isSshCaPurpose(purpose)).toBe(true);
});
