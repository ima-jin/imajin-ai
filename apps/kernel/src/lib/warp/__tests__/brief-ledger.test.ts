import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as authCrypto, verifySync, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { canReadAsset } from '@/src/lib/media/read-access';
import { canWriteAssetContent } from '@/src/lib/media/write-access';
import { browserTestingFlag, isWarpBrief } from '../brief';

const mocks = vi.hoisted(() => ({
  metadata: {} as Record<string, Record<string, unknown>>,
  rows: [] as Record<string, unknown>[],
  updates: [] as unknown[],
  createAsset: vi.fn(), failInsert: false,
  requireKey: vi.fn(), searchCorpus: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../connector', () => ({ requireAgentKey: mocks.requireKey }));
vi.mock('../environment', () => ({ readEnvironmentId: async () => undefined }));
vi.mock('../loop-emit', () => ({ emitWarpRunLoopEvent: async () => true }));
vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: async () => ({ handle: 'owner' }) }));
vi.mock('@/src/lib/kernel/corpus-client', () => ({
  searchCorpus: mocks.searchCorpus, CorpusServiceError: class extends Error {},
}));
vi.mock('@imajin/bus', () => ({ publish: async () => undefined }));
vi.mock('@imajin/logger', () => ({ createLogger: () => mocks.log }));
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

import * as ledger from '../brief-ledger';
import { dispatchAgentRun, sendFollowup } from '../dispatch';
import { WarpApiError, WarpBriefSizeError } from '../errors';
import { WARP_BRIEF_MAX_BYTES } from '../brief-limit';
import { buildCorpusContextBlock, CORPUS_CONTEXT_SEPARATOR } from '../corpus-context';
import { warpErrorResponse } from '../route-errors';
const { readBriefStorage, recordWarpBrief, writeBriefStorage } = ledger;

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
  mocks.requireKey.mockResolvedValue('fixture-agent-credential');
  mocks.searchCorpus.mockReset();
  mocks.createAsset.mockImplementation(async () => ({ asset: { id: `asset_${mocks.createAsset.mock.calls.length}` } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function verifyRow(row: Record<string, unknown>) {
  return verifySync(row.signature as string, canonicalize({
    subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: (row.issuedAt as Date).getTime(),
  }), publicKey);
}

describe('brief ledger', () => {
  it('refuses oversized direct ledger writes in both retention modes before any asset or attestation', async () => {
    const text = '今'.repeat(Math.floor(WARP_BRIEF_MAX_BYTES / 3) + 1);
    for (const did of [DID, OTHER]) await expect(recordWarpBrief(did, text)).rejects.toBeInstanceOf(WarpBriefSizeError);
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(mocks.rows).toEqual([]);
  });
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
  it('publishes the shared byte cap, failure vocabulary and hash-only confirmation disclosure in /spec', () => {
    const spec = parse(readFileSync(new URL('../../../../api-spec/jin.yaml', import.meta.url), 'utf8'));
    const description = spec.components.schemas.WarpBrief.description;
    expect(description).toContain(`WARP_BRIEF_MAX_BYTES = ${WARP_BRIEF_MAX_BYTES}`);
    expect(description).toContain('warp.brief.dispatch_failed');
    expect(description).toContain('anyone holding a guess');
    expect(description).toContain('plain SHA-256 hash');
    expect(ATTESTATION_TYPES).toContain('warp.brief.dispatch_failed');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('warp.brief.dispatch_failed');
  });
  it.each([['Browser testing: yes — because', 'yes'], ['Browser testing: no', 'no'],
    ['Browser testing: YES', 'yes'], ['none', null], ['Browser testing: maybe', null],
    ['Browser testing: maybe\nBrowser testing: no', 'no'],
    ['quoted Browser testing: yes', null]])('reads %s as %s without a classification gate', (text, flag) => {
    expect(browserTestingFlag(text)).toBe(flag);
  });
  it('scans long whitespace without regex backtracking', () => {
    expect(browserTestingFlag(`${' '.repeat(100000)}unrelated\nBrowser testing: yes`)).toBe('yes');
  });
  it.each([
    null, {}, { hash: 'x' }, { hash: 'a'.repeat(64), storage: 'hash-only', assetId: 'asset_1', browserTesting: null },
    { hash: 'a'.repeat(64), storage: 'full-text', assetId: '../unsafe', browserTesting: null },
    { hash: 'a'.repeat(64), storage: 'full-text', assetId: 'asset_1', browserTesting: 'maybe' },
  ])('refuses malformed descriptors %j', value => expect(isWarpBrief(value)).toBe(false));
});

const failureCases = [
  { status: 422, errorClass: 'http_4xx' },
  { status: 503, errorClass: 'http_5xx' },
  { status: null, errorClass: 'network' },
];

function attempt(path: 'dispatch' | 'follow-up', text = TEXT) {
  return path === 'dispatch' ? dispatchAgentRun(DID, { prompt: text })
    : sendFollowup(DID, 'run_1', { message: text });
}

function installFailure(status: number | null, onPost?: () => void) {
  const networkError = new TypeError('provider network unavailable');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ run_id: 'run_1', state: 'INPROGRESS' });
    onPost?.();
    if (status === null) throw networkError;
    return Response.json({ title: 'Provider refusal', detail: 'opaque provider detail' }, { status });
  }));
  return networkError;
}

describe.each(['dispatch', 'follow-up'] as const)('%s failed attempts', path => {
  describe.each(['full-text', 'hash-only'] as const)('%s retention', storage => {
    it.each(failureCases)('records exactly one value-free signed failure for $errorClass', async ({ status, errorClass }) => {
      mocks.metadata[DID].warpBriefStorage = storage;
      const networkError = installFailure(status);
      const failure = vi.spyOn(ledger, 'recordWarpBriefDispatchFailed');
      const error = await attempt(path).catch(error => error);
      if (status === null) expect(error).toBe(networkError);
      else expect(error).toBeInstanceOf(WarpApiError);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(failure.mock.calls[0][2]).toBe(error);
      expect(mocks.rows.map(row => row.type)).toEqual(['warp.brief.recorded', 'warp.brief.dispatch_failed']);
      const brief = mocks.rows[0].payload as { hash: string; assetId: string | null };
      expect(mocks.rows[1]).toMatchObject({
        contextId: brief.assetId ?? brief.hash,
        payload: { hash: brief.hash, assetId: brief.assetId, upstreamStatus: status, errorClass },
      });
      expect(Object.keys(mocks.rows[1].payload as object).sort()).toEqual(['assetId', 'errorClass', 'hash', 'upstreamStatus']);
      expect(mocks.rows.every(verifyRow)).toBe(true);
      expect(mocks.createAsset).toHaveBeenCalledTimes(storage === 'full-text' ? 1 : 0);
      expect(JSON.stringify(mocks.rows)).not.toContain('Exact UTF-8');
      expect(JSON.stringify(Object.values(mocks.log).map(log => log.mock.calls))).not.toContain('Exact UTF-8');
      const response = warpErrorResponse(error, {});
      expect(response.status).toBe(status === 422 ? 422 : status === null ? 500 : 502);
      const body = await response.json();
      if (status !== null) expect(body).toMatchObject({ error: 'warp_upstream_error', upstreamStatus: status, detail: 'opaque provider detail' });
    });
  });
  it.each(failureCases)('keeps the original $errorClass error even if the failure audit cannot be written', async ({ status }) => {
    const failure = vi.spyOn(ledger, 'recordWarpBriefDispatchFailed');
    const networkError = installFailure(status, () => { mocks.failInsert = true; });
    const error = await attempt(path).catch(error => error);
    expect(failure.mock.calls[0][2]).toBe(error);
    if (status === null) expect(error).toBe(networkError);
    else expect(error).toMatchObject({ status });
    expect(mocks.rows.map(row => row.type)).toEqual(['warp.brief.recorded']);
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({ hash: expect.any(String) }), expect.any(String));
  });
  it('rejects an oversized multibyte input before any storage, attestation or Warp fetch', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(attempt(path, '今'.repeat(Math.floor(WARP_BRIEF_MAX_BYTES / 3) + 1))).rejects.toBeInstanceOf(WarpBriefSizeError);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(mocks.rows).toEqual([]);
  });
  it('accepts exactly the byte cap without trimming or changing the hash', async () => {
    const text = '今'.repeat(Math.floor(WARP_BRIEF_MAX_BYTES / 3)) + 'x'.repeat(WARP_BRIEF_MAX_BYTES % 3);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => Response.json({
      run_id: 'run_1', state: init.method === 'GET' ? 'INPROGRESS' : 'QUEUED',
    })));
    await attempt(path, text);
    const call = vi.mocked(fetch).mock.calls.at(-1)!;
    const outgoing = JSON.parse(call[1]!.body as string);
    expect(outgoing.prompt ?? outgoing.message).toBe(text);
    expect(mocks.rows[0].payload).toMatchObject({ hash: createHash('sha256').update(text).digest('hex') });
    expect(mocks.rows).toHaveLength(1);
  });
});

describe('final corpus-prefixed prompt byte budget', () => {
  const at = '2026-10-26T00:00:00.000Z';
  const hit = { source: 's', id: '1', type: 'issue', title: 'evidence', state: 'open', score: 1, updated: at, evidence: ['今'.repeat(100001)] };
  it.each([0, 1])('counts the largest HTTP corpus prefix before storage, with %i bytes over the cap', async over => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    mocks.searchCorpus.mockResolvedValue({ results: [hit] });
    const prefix = buildCorpusContextBlock([hit], { source: 's', ref: undefined, retrievedAt: at }, 100000).block + CORPUS_CONTEXT_SEPARATOR;
    const prompt = 'x'.repeat(WARP_BRIEF_MAX_BYTES - Buffer.byteLength(prefix) + over);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ run_id: 'run_1', state: 'QUEUED' })));
    const result = dispatchAgentRun(DID, { prompt, corpusContext: { source: 's', query: 'q', maxChars: 100000 } });
    if (over) {
      await expect(result).rejects.toBeInstanceOf(WarpBriefSizeError);
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.createAsset).not.toHaveBeenCalled();
      expect(mocks.rows).toEqual([]);
    } else {
      await result;
      const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).prompt;
      expect(sent).toBe(prefix + prompt);
      expect(Buffer.byteLength(sent)).toBe(WARP_BRIEF_MAX_BYTES);
      expect(mocks.rows[0].payload).toMatchObject({ hash: createHash('sha256').update(sent).digest('hex') });
    }
  });
});
