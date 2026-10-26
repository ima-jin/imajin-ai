import { randomBytes, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as authCrypto, verifySync } from '@imajin/auth';
import { canReadAsset } from '@/src/lib/media/read-access';
import { canWriteAssetContent } from '@/src/lib/media/write-access';
import { browserTestingFlag, isWarpBrief } from '../brief';

const mocks = vi.hoisted(() => ({
  metadata: {} as Record<string, Record<string, unknown>>,
  rows: [] as Record<string, unknown>[],
  updates: [] as unknown[],
  createAsset: vi.fn(), failInsert: false,
}));
vi.mock('drizzle-orm', () => ({ eq: (column: string, value: string) => [column, value] }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: mocks.createAsset }));
vi.mock('@/src/db', () => {
  const where = ([, did]: string[]) => ({
    limit: async () => mocks.metadata[did] ? [{ metadata: mocks.metadata[did] }] : [],
    for: async () => [],
  });
  const from = () => ({ where });
  const executor = {
    select: () => ({ from }),
    insert: () => ({ values: async (row: Record<string, unknown>) => {
      if (mocks.failInsert) throw new Error('insert failed');
      mocks.rows.push(row);
    } }),
    update: (table: { name?: string }) => ({ set: (values: Record<string, unknown>) => ({
      where: async ([, id]: string[]) => {
        mocks.updates.push({ table, values, id });
        if (table.name === 'identities') mocks.metadata[id] = values.metadata as Record<string, unknown>;
      },
    }) }),
  };
  return {
    db: { ...executor, transaction: async (fn: (tx: typeof executor) => Promise<unknown>) => {
      const snapshot = structuredClone({ metadata: mocks.metadata, rows: mocks.rows, updates: mocks.updates });
      try { return await fn(executor); } catch (error) { Object.assign(mocks, snapshot); throw error; }
    } },
    assets: { id: 'asset.id' }, attestations: 'attestations',
    identities: { name: 'identities', id: 'identity.id', metadata: 'metadata' },
  };
});

import { readBriefStorage, recordWarpBrief, writeBriefStorage } from '../brief-ledger';

const DID = 'did:imajin:owner';
const OTHER = 'did:imajin:other';
const TEXT = '  Browser testing: yes — route\n\nExact UTF-8: 今人\r\n  ';
let publicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  const seed = randomBytes(32).toString('hex');
  publicKey = authCrypto.getPublicKey(seed);
  vi.stubEnv('AUTH_PRIVATE_KEY', seed);
  mocks.metadata = { [DID]: {}, [OTHER]: { warpBriefStorage: 'hash-only' } };
  mocks.rows = [];
  mocks.updates = [];
  mocks.failInsert = false;
  mocks.createAsset.mockImplementation(async () => ({ asset: { id: `asset_${mocks.createAsset.mock.calls.length}` } }));
});
afterEach(() => vi.unstubAllEnvs());

function verifyRow(row: Record<string, unknown>) {
  return verifySync(row.signature as string, canonicalize({
    subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: (row.issuedAt as Date).getTime(),
  }), publicKey);
}

describe('brief ledger', () => {
  it('defaults to full text and stores exact bytes privately and immutably using the existing asset primitive', async () => {
    expect(await readBriefStorage(DID)).toBe('full-text');
    const brief = await recordWarpBrief(DID, TEXT);
    expect(brief).toEqual({
      hash: createHash('sha256').update(TEXT).digest('hex'), assetId: 'asset_1',
      storage: 'full-text', browserTesting: 'yes',
    });
    expect(mocks.createAsset).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid: DID, buffer: Buffer.from(TEXT), access: 'private', immutable: true,
      dedup: false, classify: false, status: 'processing', tx: expect.anything(),
    }));
    expect(mocks.rows[0].payload).toEqual(brief);
    expect(verifyRow(mocks.rows[0])).toBe(true);
    expect(JSON.stringify(mocks.rows)).not.toContain(TEXT);
  });

  it('hash-only creates no asset and no text-bearing record, independently per principal', async () => {
    const brief = await recordWarpBrief(OTHER, TEXT);
    expect(brief).toMatchObject({ storage: 'hash-only', assetId: null, hash: createHash('sha256').update(TEXT).digest('hex') });
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
    expect(verifyRow(mocks.rows[0])).toBe(true);
    expect(await readBriefStorage(DID)).toBe('full-text');
  });

  it('records separate follow-up assets/hashes and retains earlier briefs when switching mode', async () => {
    const first = await recordWarpBrief(DID, TEXT);
    const second = await recordWarpBrief(DID, `${TEXT}follow-up`);
    await writeBriefStorage(DID, DID, 'hash-only');
    const third = await recordWarpBrief(DID, 'next');
    expect(new Set([first.hash, second.hash, third.hash]).size).toBe(3);
    expect(first.assetId).not.toBe(second.assetId);
    expect(third.assetId).toBeNull();
    expect(mocks.createAsset).toHaveBeenCalledTimes(2);
    expect(mocks.rows).toHaveLength(4);
    expect(mocks.updates).not.toContainEqual(expect.objectContaining({ values: { status: 'deleted' } }));
  });

  it('signs the setting change with principal, human actor and previous mode atomically', async () => {
    mocks.metadata[DID].unrelated = 'preserved';
    const result = await writeBriefStorage(DID, 'did:imajin:human', 'hash-only');
    expect(result.attestationId).toMatch(/^att_/);
    expect(mocks.rows[0]).toMatchObject({
      subjectDid: DID, type: 'warp.brief.storage.changed',
      payload: { previous: 'full-text', storage: 'hash-only', actingHumanDid: 'did:imajin:human' },
    });
    expect(verifyRow(mocks.rows[0])).toBe(true);
    expect(mocks.metadata[DID]).toEqual({ unrelated: 'preserved', warpBriefStorage: 'hash-only' });
    expect(await readBriefStorage(OTHER)).toBe('hash-only');
    await writeBriefStorage(DID, DID, 'full-text');
    expect(mocks.rows).toHaveLength(2);
  });

  it('never changes the preference if the signed event cannot commit', async () => {
    mocks.failInsert = true;
    await expect(writeBriefStorage(DID, DID, 'hash-only')).rejects.toThrow();
    expect(await readBriefStorage(DID)).toBe('full-text');
    expect(mocks.rows).toEqual([]);
  });

  it('fails closed on missing principals, corrupt preferences, signing or asset failures', async () => {
    await expect(readBriefStorage('did:missing')).rejects.toThrow();
    mocks.metadata[DID].warpBriefStorage = 'corrupt';
    await expect(recordWarpBrief(DID, TEXT)).rejects.toThrow();
    expect(mocks.createAsset).not.toHaveBeenCalled();
    mocks.metadata[DID] = {};
    mocks.createAsset.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(recordWarpBrief(DID, TEXT)).rejects.toThrow();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(writeBriefStorage(DID, DID, 'hash-only')).rejects.toThrow();
    expect(mocks.rows).toEqual([]);
  });

  it('rejects invalid setting values even for in-process callers', async () => {
    await expect(writeBriefStorage(DID, DID, 'invalid' as 'full-text')).rejects.toThrow();
    expect(mocks.rows).toEqual([]);
  });

  it('uses normal private asset rules: another principal and anonymous readers cannot read, even the owner cannot edit', () => {
    const subject = { ownerDid: DID, access: 'private' as const };
    expect(canReadAsset(subject, OTHER).allowed).toBe(false);
    expect(canReadAsset(subject, null).allowed).toBe(false);
    expect(canReadAsset(subject, DID).allowed).toBe(true);
    expect(canWriteAssetContent({ ownerDid: DID, immutable: true }, DID).allowed).toBe(false);
  });
});

describe('brief telemetry validation', () => {
  it.each([['Browser testing: yes — because', 'yes'], ['Browser testing: no', 'no'],
    ['Browser testing: YES', 'yes'], ['none', null], ['Browser testing: maybe', null],
    ['quoted Browser testing: yes', null]])('reads %s as %s without a classification gate', (text, flag) => {
    expect(browserTestingFlag(text)).toBe(flag);
  });
  it.each([
    null, {}, { hash: 'x' }, { hash: 'a'.repeat(64), storage: 'hash-only', assetId: 'asset_1', browserTesting: null },
    { hash: 'a'.repeat(64), storage: 'full-text', assetId: '../unsafe', browserTesting: null },
    { hash: 'a'.repeat(64), storage: 'full-text', assetId: 'asset_1', browserTesting: 'maybe' },
  ])('refuses malformed descriptors %j', value => expect(isWarpBrief(value)).toBe(false));
});
