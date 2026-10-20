import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { CompactSign } from 'jose';
import { NextRequest } from 'next/server';
import { crypto as authCrypto, provideInternalApiKey, ATTESTATION_TYPES } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import * as auth from '@/src/db/schemas/auth';
import * as media from '@/src/db/schemas/media';
import { authorizeAssetRead } from '@/src/lib/media/authorize-read';
import { buildDocumentSigningPayload } from '../document-signing-payload';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  publish: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  chain: vi.fn().mockResolvedValue({ log: ['chain'] }),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/media'),
  get db() { return mocks.db; },
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, copyFile: mocks.copyFile }));
vi.mock('@/src/lib/auth/dfos', () => ({ getChainByImajinDid: mocks.chain }));
vi.mock('@imajin/dfos', () => ({ verifyChain: vi.fn().mockResolvedValue({ isDeleted: false, authKeys: ['human-key'] }) }));

import { GET as LIST, POST as CREATE } from '@/app/auth/api/documents/route';
import { GET as DETAIL } from '@/app/auth/api/documents/[id]/route';
import { POST as SIGN } from '@/app/auth/api/documents/[id]/sign/route';
import { POST as IDENTITY_SIGN } from '@/app/auth/api/identity/[did]/sign/route';
import { verifyDocumentSignatureToken } from '../document-signatures';

const pg = new PGlite();
const database = drizzle(pg);
const org = 'did:imajin:org';
const owner = 'did:imajin:owner';
const admin = 'did:imajin:admin';
const member = 'did:imajin:member';
const stranger = 'did:imajin:stranger';
const bob = 'did:imajin:bob';
const carol = 'did:imajin:carol';
const hash = 'sha256-original';
const nodeSeed = '1'.repeat(64);
const bobKeys = generateKeyPairSync('ed25519');
const bobPublic = bobKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const token = (did: string, contentHash = hash) => authCrypto.signSync(buildDocumentSigningPayload(did, contentHash), nodeSeed);
const jwtHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

function request(did: string, body?: unknown, actingAs?: string, suffix = '') {
  const sessionToken = `${jwtHeader}.${Buffer.from(did).toString('base64url')}.test-signature`;
  return new NextRequest(`http://localhost/auth/api/documents${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      'content-type': 'application/json',
      ...(actingAs ? { 'x-acting-as': actingAs } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function createBody(overrides: Record<string, unknown> = {}) {
  return { title: 'Org agreement', document_asset_id: 'asset_original', document_hash: hash,
    signers: [bob], author_jws: token(org), ...overrides };
}
async function create(overrides: Record<string, unknown> = {}) {
  const response = await CREATE(request(owner, createBody(overrides), org));
  expect(response.status).toBe(201);
  return (await response.json()).attestation.id as string;
}
async function sign(id: string, did = bob, contentHash = hash, jws = token(did, contentHash)) {
  return SIGN(request(did, { document_hash: contentHash, jws }), params(id));
}
async function counts() {
  return {
    attestations: await database.select().from(auth.attestations),
    signatures: await database.select().from(auth.attestationSignatures),
    assets: await database.select().from(media.assets),
    members: await database.select().from(auth.identityMembers),
  };
}

beforeAll(async () => {
  mocks.db = database;
  for (const table of [auth.identities, auth.identityMembers, auth.attestations,
    auth.attestationSignatures, media.assets, media.folders, media.assetFolders]) {
    const config = getTableConfig(table);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${config.schema}";`);
    const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`);
    await pg.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')});`);
  }
}, 60000);
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec('TRUNCATE auth.identities, auth.identity_members, auth.attestations, auth.attestation_signatures, media.assets, media.folders, media.asset_folders');
  vi.stubEnv('AUTH_PRIVATE_KEY', nodeSeed);
  vi.stubEnv('AUTH_SERVICE_URL', 'http://auth.test/auth');
  provideInternalApiKey('test-vault-value');
  await database.insert(auth.identities).values([
    { id: org, scope: 'business', publicKey: '', name: 'Org' },
    ...[owner, admin, member, stranger, bob, carol].map((id) => ({
      id, scope: 'actor', subtype: 'human', publicKey: id === bob ? bobPublic : authCrypto.getPublicKey(nodeSeed),
    })),
  ]);
  await database.insert(auth.identityMembers).values([
    { identityDid: org, memberDid: owner, role: 'owner', allowedServices: null },
    { identityDid: org, memberDid: admin, role: 'admin', allowedServices: ['auth'] },
    { identityDid: org, memberDid: member, role: 'member', allowedServices: ['media'] },
  ]);
  await database.insert(media.assets).values({ id: 'asset_original', ownerDid: org,
    filename: 'agreement.pdf', mimeType: 'application/pdf', size: 12,
    hash, storagePath: '/test/original.pdf', immutable: false, status: 'active',
    fairManifest: { access: 'private' },
  });
  // Exercise the real shared auth/allowed_services gate; only its HTTP transport is stubbed.
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/api/session')) {
      const cookie = (options.headers as { Cookie: string }).Cookie;
      const did = Buffer.from(cookie.split('.')[1], 'base64url').toString();
      return Response.json({ did, scope: 'actor', subtype: 'human', tier: 'hard' });
    }
    const match = /\/groups\/([^/]+)\/controllers\/([^/]+)$/.exec(url);
    if (match) {
      const [row] = await database.select().from(auth.identityMembers).where(and(
        eq(auth.identityMembers.identityDid, decodeURIComponent(match[1])),
        eq(auth.identityMembers.memberDid, decodeURIComponent(match[2])),
      ));
      return Response.json({ valid: Boolean(row && !row.removedAt), role: row?.role, allowedServices: row?.allowedServices });
    }
    throw new Error(`Unexpected test transport ${url}`);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await pg.close(); });

describe('org document agreement acceptance (#2998)', () => {
  it('records the org author/first signature and human provenance, deduplicates signers, and registers agreement', async () => {
    const id = await create({ signers: [org, bob, bob], payload: { actingHumanDid: 'spoof', orgDid: 'spoof' } });
    const state = await counts();
    expect(ATTESTATION_TYPES).toContain('agreement');
    expect(state.attestations).toMatchObject([{ issuerDid: org, subjectDid: bob, type: 'document.created',
      totalSigners: 2, attestationStatus: 'collecting', documentHash: hash,
      payload: { orgDid: org, documentHash: hash, counterpartyDids: [bob], actingHumanDid: owner,
        signedBy: { [org]: { actingHumanDid: owner, signatureModel: 'node-witness' } } } }]);
    expect(state.signatures).toHaveLength(2);
    expect(state.signatures).toContainEqual(expect.objectContaining({ signerDid: org, status: 'signed', role: 'creator', jws: token(org) }));
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith('document.created', expect.objectContaining({
      issuer: org, subject: bob, payload: expect.objectContaining({ signUrl: `/auth/documents/${id}` }),
    }));
    expect(state.assets.filter((asset) => asset.id !== 'asset_original')).toMatchObject([
      { ownerDid: org, immutable: true, fairManifest: { access: 'private' }, metadata: { documentId: id } },
    ]);
  });

  it.each([owner, admin])('lets an auth-authorized owner/admin witness org approval without pretending the org has a key (%s)', async (did) => {
    const response = await IDENTITY_SIGN(request(did, { payload: buildDocumentSigningPayload(org, hash) }, org), {
      params: Promise.resolve({ did: encodeURIComponent(org) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signature: token(org), signatureModel: 'node-witness' });
    expect(mocks.chain).toHaveBeenCalledWith(did);
  });

  it.each([{ services: [] }, { services: ['media'] }])('denies auth-restricted act-as with no signing or database writes (%j)', async ({ services }) => {
    await database.update(auth.identityMembers).set({ allowedServices: services }).where(eq(auth.identityMembers.memberDid, admin));
    const before = await counts();
    expect((await CREATE(request(admin, createBody(), org))).status).toBe(403);
    expect((await IDENTITY_SIGN(request(admin, { payload: buildDocumentSigningPayload(org, hash) }, org), {
      params: Promise.resolve({ did: org }),
    })).status).toBe(403);
    expect(await counts()).toEqual(before);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
  });

  it('denies maintainers and nonmembers, and never falls back to a human author', async () => {
    await database.update(auth.identityMembers).set({ role: 'maintainer', allowedServices: ['auth'] })
      .where(eq(auth.identityMembers.memberDid, admin));
    for (const did of [admin, member, stranger]) {
      expect((await CREATE(request(did, createBody(), org))).status).toBe(403);
    }
    expect((await counts()).attestations).toEqual([]);
  });

  it('executes only after all unique parties sign and keeps agreement visible in lists', async () => {
    const id = await create({ signers: [bob, carol, bob] });
    expect((await sign(id)).status).toBe(200);
    expect((await counts()).attestations[0]).toMatchObject({ type: 'document.created', attestationStatus: 'collecting' });
    expect((await sign(id, carol)).status).toBe(200);
    const state = await counts();
    expect(state.attestations[0]).toMatchObject({ type: 'agreement', attestationStatus: 'executed',
      payload: { signedBy: { [bob]: { actingHumanDid: bob }, [carol]: { actingHumanDid: carol } } } });
    for (const did of [owner, member, bob]) {
      const response = await LIST(request(did));
      expect(response.status).toBe(200);
      expect((await response.json()).documents).toMatchObject([{ id, type: 'agreement', signatureCounts: { signed: 3 } }]);
    }
    expect((await LIST(request(stranger))).status).toBe(200);
    expect((await (await LIST(request(stranger))).json()).documents).toEqual([]);
  });

  it('rejects wrong signer, wrong hash and valid compact signatures over the wrong payload without any writes', async () => {
    const id = await create();
    const before = await counts();
    const badPayloads = [
      buildDocumentSigningPayload(bob, 'tampered'),
      buildDocumentSigningPayload(stranger, hash),
      JSON.stringify({ unrelated: true }),
      'not-json',
    ];
    expect((await sign(id, stranger)).status).toBe(403);
    expect((await sign(id, bob, 'tampered')).status).toBe(400);
    for (const payload of badPayloads) {
      const jws = await new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'EdDSA' }).sign(bobKeys.privateKey);
      expect((await sign(id, bob, hash, jws)).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
    expect(mocks.copyFile).toHaveBeenCalledTimes(1); // creator only
  });

  it('accepts DID-key compact signatures bound to the expected DID and hash', async () => {
    const id = await create();
    const jws = await new CompactSign(Buffer.from(buildDocumentSigningPayload(bob, hash)))
      .setProtectedHeader({ alg: 'EdDSA' }).sign(bobKeys.privateKey);
    expect(await verifyDocumentSignatureToken({ token: jws, signerPublicKeyHex: bobPublic, signerDid: bob, documentHash: hash })).toBe(true);
    expect((await sign(id, bob, hash, jws)).status).toBe(200);
    expect((await counts()).attestations[0].payload).toMatchObject({
      signedBy: { [bob]: { signatureModel: 'did-key', actingHumanDid: bob } },
    });
  });

  it('serializes concurrent/replayed final signatures and emits execution once', async () => {
    const id = await create();
    const responses = await Promise.all([sign(id), sign(id), sign(id)]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409, 409]);
    expect((await counts()).signatures.filter((signature) => signature.status === 'signed')).toHaveLength(2);
    expect(mocks.publish.mock.calls.filter(([event]) => event === 'document.executed')).toHaveLength(1);
    expect(mocks.copyFile).toHaveBeenCalledTimes(2);
  });

  it('makes separate immutable private copies; org members can read theirs but counterparty cannot read org internals', async () => {
    const id = await create();
    await sign(id);
    const state = await counts();
    const copies = state.assets.filter((asset) => asset.id !== 'asset_original');
    expect(copies.map((asset) => asset.ownerDid).sort()).toEqual([bob, org].sort());
    for (const copy of copies) {
      expect(copy.storagePath).toContain('/.signed/');
      expect(copy).toMatchObject({ immutable: true, fairManifest: { access: 'private' } });
      const subject = { ownerDid: copy.ownerDid, access: 'private' as const };
      expect((await authorizeAssetRead(subject, copy.ownerDid)).allowed).toBe(true);
      expect((await authorizeAssetRead(subject, stranger)).allowed).toBe(false);
      expect((await authorizeAssetRead(subject, null)).allowed).toBe(false);
    }
    const orgCopy = copies.find((asset) => asset.ownerDid === org)!;
    expect((await authorizeAssetRead({ ownerDid: org, access: 'private' }, member)).allowed).toBe(true);
    expect((await authorizeAssetRead({ ownerDid: org, access: 'private' }, bob)).allowed).toBe(false);
    expect(state.members).toHaveLength(3);
    const bobDetail = await DETAIL(request(bob), params(id));
    expect((await bobDetail.json()).attestation.documentAssetId).toBe(copies.find((asset) => asset.ownerDid === bob)!.id);
    const memberDetail = await DETAIL(request(member), params(id));
    expect((await memberDetail.json()).attestation.documentAssetId).toBe(orgCopy.id);
    expect((await DETAIL(request(stranger), params(id))).status).toBe(403);
  });

  it('fails conflicting creation payloads and creator/self-only signer sets before writes', async () => {
    const before = await counts();
    for (const overrides of [{ payload: { documentHash: 'different' } }, { signers: [org, org] },
      { document_hash: 'different' }, { author_jws: token(owner) }]) {
      expect((await CREATE(request(owner, createBody(overrides), org))).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  it('rejects revoked, expired, declined and inconsistent stored hashes without writes', async () => {
    const id = await create();
    const changes = [
      { revokedAt: new Date() },
      { revokedAt: null, expiresAt: new Date(0) },
      { expiresAt: null, attestationStatus: 'declined' },
      { attestationStatus: 'collecting', payload: { documentHash: 'wrong' } },
    ];
    for (const change of changes) {
      await database.update(auth.attestations).set(change).where(eq(auth.attestations.id, id));
      const before = await counts();
      expect((await sign(id)).status).toBeGreaterThanOrEqual(400);
      expect(await counts()).toEqual(before);
    }
  });

  it('rolls back creation and countersigning if a private copy cannot be persisted', async () => {
    const beforeCreation = await counts();
    mocks.copyFile.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await CREATE(request(owner, createBody(), org))).status).toBe(500);
    expect(await counts()).toEqual(beforeCreation);
    expect(mocks.publish).not.toHaveBeenCalled();
    const id = await create();
    const beforeSigning = await counts();
    mocks.copyFile.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await sign(id)).status).toBe(500);
    expect(await counts()).toEqual(beforeSigning);
    expect((await sign(id)).status).toBe(200);
  });

  it('reuses the org signed-documents folder across distinct documents', async () => {
    await create();
    await create();
    const folders = await database.select().from(media.folders);
    expect(folders).toMatchObject([{ ownerDid: org, name: 'Signed Documents', isSystem: true }]);
    expect((await counts()).assets.filter((asset) => asset.ownerDid === org)).toHaveLength(3);
  });

  it('rejects unauthorized sessions, restricted countersigning and invalid JSON without writes', async () => {
    const id = await create();
    const before = await counts();
    const unauthorized = new NextRequest('http://localhost/auth/api/documents', { method: 'POST', body: '{}' });
    expect((await CREATE(unauthorized)).status).toBe(401);
    expect((await LIST(unauthorized)).status).toBe(401);
    expect((await DETAIL(unauthorized, params(id))).status).toBe(401);
    expect((await SIGN(unauthorized, params(id))).status).toBe(401);
    await database.update(auth.identityMembers).set({ allowedServices: ['media'] })
      .where(eq(auth.identityMembers.memberDid, admin));
    const restricted = request(admin, { jws: token(org), document_hash: hash }, org);
    expect((await SIGN(restricted, params(id))).status).toBe(403);
    for (const body of [null, {}, { jws: 123 }, { jws: 'abc' }, { jws: 'abc', document_hash: 123 }]) {
      expect((await SIGN(request(bob, body), params(id))).status).toBe(400);
    }
    expect((await SIGN(new NextRequest('http://localhost', {
      method: 'POST', headers: request(bob).headers, body: '{invalid',
    }), params(id))).status).toBe(400);
    // The deliberate service-restriction change is not a route write.
    expect((await counts()).signatures).toEqual(before.signatures);
    expect((await counts()).attestations).toEqual(before.attestations);
    expect((await counts()).assets).toEqual(before.assets);
  });

  it('denies removed org readers and refuses non-document details', async () => {
    const id = await create();
    await database.update(auth.identityMembers).set({ removedAt: new Date() })
      .where(eq(auth.identityMembers.memberDid, member));
    expect((await DETAIL(request(member), params(id))).status).toBe(403);
    expect((await (await LIST(request(member))).json()).documents).toEqual([]);
    await database.update(auth.attestations).set({ documentHash: null }).where(eq(auth.attestations.id, id));
    expect((await DETAIL(request(owner), params(id))).status).toBe(404);
    expect((await sign('missing-document')).status).toBe(404);
  });

  it('fails closed for malformed, mismatched or unavailable node-witness signatures', async () => {
    const input = { token: token(bob), signerPublicKeyHex: bobPublic, signerDid: bob, documentHash: hash };
    expect(await verifyDocumentSignatureToken(input)).toBe(true);
    expect(await verifyDocumentSignatureToken({ ...input, token: 'not-a-signature' })).toBe(false);
    expect(await verifyDocumentSignatureToken({ ...input, signerDid: stranger })).toBe(false);
    expect(await verifyDocumentSignatureToken({ ...input, documentHash: 'different' })).toBe(false);
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect(await verifyDocumentSignatureToken(input)).toBe(false);
    vi.stubEnv('AUTH_PRIVATE_KEY', 'invalid');
    expect(await verifyDocumentSignatureToken(input)).toBe(false);
  });

  it('does not witness identity payloads with a different DID or missing human chain', async () => {
    const path = { params: Promise.resolve({ did: org }) };
    expect((await IDENTITY_SIGN(request(owner, { payload: buildDocumentSigningPayload(owner, hash) }, org), path)).status).toBe(400);
    expect((await IDENTITY_SIGN(request(owner, { payload: buildDocumentSigningPayload(org, hash) }), path)).status).toBe(403);
    mocks.chain.mockResolvedValueOnce(null);
    const response = await IDENTITY_SIGN(request(owner, { payload: buildDocumentSigningPayload(org, hash) }, org), path);
    expect(await response.json()).toMatchObject({ signed: false, reason: 'no_chain' });
    expect((await counts()).attestations).toEqual([]);
  });
});
