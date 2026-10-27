import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { signManifest, type SignedFairManifest } from '@imajin/fair';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { legalEntityFixture, ownerDid, viewerDid } from './legal-entity-fixture';
import { composeLegalEntity, composeLegalEntityRevocation } from '../legal-entity-document';
import { LEGAL_ENTITY_MAX_BYTES } from '../legal-entity-schema';

const h = vi.hoisted(() => ({
  asset: null as any, key: '', nodeDid: 'did:imajin:node',
  assets: { createdAt: 'created_at', id: 'id' }, identities: {}, create: vi.fn(), update: vi.fn(), broker: vi.fn(),
  orderBy: vi.fn(), lock: vi.fn(),
  execute: vi.fn(), transaction: vi.fn(), select: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  db: { select: h.select, transaction: h.transaction },
  assets: h.assets, identities: h.identities,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: h.create }));
vi.mock('@/src/lib/media/update-asset', () => ({ withAssetContentLock: h.lock }));
vi.mock('@imajin/bus', () => ({
  broker: h.broker,
  isBrokerRelease: (value: { status: string }) => value.status === 'released',
}));
import { getLegalEntity, getOwnerLegalEntity, saveLegalEntity } from '../legal-entity';

async function signedSource(content: string, did = ownerDid, purpose: string | undefined = 'legal-entity') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  h.key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const hash = createHash('sha256').update(content).digest('hex');
  const manifest = await signManifest({
    id: 'asset_legal', owner: did, fair: '1.1', version: '1.1',
    created: new Date().toISOString(), type: 'text/markdown',
    access: { type: 'private' }, attribution: [],
    ...(purpose ? { intent: { purpose } } : {}),
    integrity: { hash, size: Buffer.byteLength(content) },
  }, { did: 'did:imajin:node', privateKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)) });
  const path = `${await mkdtemp(`${tmpdir()}/legal-entity-test-`)}/legal-entity.md`;
  await writeFile(path, content);
  h.asset = {
    id: 'asset_legal', ownerDid: did, status: 'active', hash,
    fairManifest: manifest, storagePath: path, versionCount: 1,
  };
  return manifest;
}

function lookupResult(table: unknown) {
  return {
    orderBy: h.orderBy,
    limit: async () => table === h.identities
      ? h.key ? [{ publicKey: h.key }] : []
      : h.asset?.status === 'active' ? [structuredClone(h.asset)] : [],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.nodeDid = 'did:imajin:node';
  h.select.mockImplementation(() => ({ from: (table: unknown) => ({
    where: () => lookupResult(table),
  }) }));
  h.orderBy.mockImplementation(() => ({ limit: async () => h.asset?.status === 'active' ? [structuredClone(h.asset)] : [] }));
  h.broker.mockResolvedValue({ status: 'rejected' });
  h.transaction.mockImplementation(async fn => fn({ execute: h.execute }));
  h.lock.mockImplementation(async (_did, action) => {
    await h.execute();
    return action(h.update);
  });
  h.create.mockResolvedValue({ asset: { id: 'asset_new' } });
  h.update.mockResolvedValue({ ok: true });
  const input = legalEntityFixture();
  input.visibility.legalName = 'public';
  input.visibility.operatingName = 'never';
  await signedSource(composeLegalEntity(ownerDid, input));
});

describe('getLegalEntity signed-source contract', () => {
  it.each([false, true])('orders two active records newest first with deterministic id ties (same time: %s)', async sameTime => {
    const newest = structuredClone(h.asset);
    const older = { ...newest, id: 'asset_aaa', createdAt: new Date(sameTime ? '2026-02-01' : '2026-01-01') };
    newest.createdAt = new Date('2026-02-01');
    const rows = [older, newest].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    h.orderBy.mockImplementation(() => ({
      limit: async () => rows.slice(0, 1),
    }));
    expect(await getOwnerLegalEntity(ownerDid)).toMatchObject({ assetId: newest.id });
    expect(await getLegalEntity(ownerDid, viewerDid)).toEqual({ legalName: 'Example Legal Ltd' });
    for (const ordering of h.orderBy.mock.calls) {
      const query = new PgDialect().sqlToQuery(sql.join(ordering, sql`, `));
      expect(query.sql).toBe('$1 desc, $2 desc');
      expect(query.params).toEqual(['created_at', 'id']);
    }
  });
  it.each(['other-purpose', ''])('rejects a genuinely node-signed document with purpose %j', async purpose => {
    await signedSource(composeLegalEntity(ownerDid, legalEntityFixture()), ownerDid, purpose);
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
    await expect(getOwnerLegalEntity(ownerDid)).rejects.toThrow('binding mismatch');
  });
  it('verifies real Ed25519 signatures and returns only released fields', async () => {
    expect(await getLegalEntity(ownerDid, viewerDid)).toEqual({ legalName: 'Example Legal Ltd' });
    expect(await getLegalEntity(ownerDid, null)).toEqual({ legalName: 'Example Legal Ltd' });
    const owner = await getOwnerLegalEntity(ownerDid);
    expect(owner?.record.operatingName).toBe('Example');
    expect(owner?.assetId).toBe('asset_legal');
  });
  it('returns null for a missing/deleted source', async () => {
    h.asset.status = 'deleted';
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
    expect(await getOwnerLegalEntity(ownerDid)).toBeNull();
  });
  it('does not return a signed tombstone as an entity', async () => {
    await signedSource(composeLegalEntityRevocation(ownerDid));
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
    expect(await getOwnerLegalEntity(ownerDid)).toBeNull();
  });
  it('does not disclose content if disk bytes were changed', async () => {
    await writeFile(h.asset.storagePath, 'tampered');
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
    await expect(getOwnerLegalEntity(ownerDid)).rejects.toThrow('binding mismatch');
  });
  it.each(['signature', 'owner', 'id', 'integrity', 'hash', 'key', 'node'])('rejects missing/mismatched %s', async field => {
    const manifest = h.asset.fairManifest as SignedFairManifest;
    if (field === 'signature') Reflect.deleteProperty(manifest, 'signature');
    if (field === 'owner') manifest.owner = 'another-owner';
    if (field === 'id') manifest.id = 'another-asset';
    if (field === 'integrity') manifest.integrity!.size += 1;
    if (field === 'hash') h.asset.hash = 'wrong';
    if (field === 'key') h.key = '';
    if (field === 'node') h.nodeDid = '';
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
  });
  it('rejects an incorrect public key even if the signed hash matches', async () => {
    const key = generateKeyPairSync('ed25519').publicKey;
    h.key = key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
  });
  it('rejects signed malformed or overlarge documents', async () => {
    await signedSource('invalid document');
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
    await signedSource('a'.repeat(LEGAL_ENTITY_MAX_BYTES + 1));
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
  });
  it('fails closed if storage is unavailable', async () => {
    h.asset.storagePath = '/nonexistent-legal-entity-test-file';
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
  });
  it.each(['edit', 'revoke'])('discards a read when %s happens during a broker call', async operation => {
    h.broker.mockImplementation(async () => {
      if (operation === 'edit') h.asset.hash = 'new-hash';
      else h.asset.status = 'deleted';
      return { status: 'rejected' };
    });
    expect(await getLegalEntity(ownerDid, viewerDid)).toBeNull();
  });
});
describe('legal entity owner persistence orchestration', () => {
  it('creates the private conventional media document without dedup or classification', async () => {
    h.asset = null;
    await saveLegalEntity(ownerDid, viewerDid, legalEntityFixture());
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid, uploadedBy: viewerDid, filename: 'legal-entity.md',
      dedup: false, classify: false, access: 'private', controlDocument: 'legal-entity',
    }));
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'asset_new', composedBy: viewerDid }));
  });
  it('edits the existing signed doc rather than creating a copy', async () => {
    await saveLegalEntity(ownerDid, viewerDid, legalEntityFixture());
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 'asset_legal', requesterDid: ownerDid, composedBy: viewerDid, controlDocument: 'legal-entity',
    }));
  });
  it('revokes through document.changed with status: deleted while retaining rows', async () => {
    await saveLegalEntity(ownerDid, viewerDid, null);
    const input = h.update.mock.calls[0][0];
    expect(input.content).toBe(composeLegalEntityRevocation(ownerDid));
    expect(input.content).not.toContain('Example');
    expect(h.lock).toHaveBeenCalledWith(ownerDid, expect.any(Function));
  });
  it('treats repeat deletion as a no-op', async () => {
    h.asset.status = 'deleted';
    await saveLegalEntity(ownerDid, viewerDid, null);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it('propagates failed writes instead of reporting a signed save', async () => {
    h.update.mockResolvedValue({ ok: false, code: 'signing_failed' });
    await expect(saveLegalEntity(ownerDid, viewerDid, legalEntityFixture())).rejects.toThrow('signing_failed');
  });
});
