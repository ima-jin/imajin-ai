import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { updateAssetContent, withAssetContentLock } from '../update-asset';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// updateAssetContent is the single authored-document write path (#1170). We
// stub every side-effecting dependency so the test isolates the #1205
// document.changed trigger: an authored-doc write must publish exactly one
// document.changed with { path, cid, prevCid } and an owner issuer; a
// non-authored write must never fire it (discipline rule 1).

const mockLimit = vi.fn();
const mockSelectWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockAttestationValues = vi.fn();
const mockExecute = vi.fn().mockResolvedValue(undefined);

vi.mock('@/src/db', () => ({
  db: {
    transaction: vi.fn(async fn => fn({
      execute: mockExecute,
      update: () => ({ set: mockSet }),
      insert: () => ({ values: mockAttestationValues }),
    })),
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
  attestations: {},
}));
const legalMocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: legalMocks.prepare }));
import { composeLegalEntity, composeLegalEntityRevocation } from '../../profile/legal-entity-document';
import { legalEntityFixture, ownerDid } from '../../profile/__tests__/legal-entity-fixture';
import { canWriteAssetContent } from '../write-access';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/cid', () => ({
  computeCid: vi.fn().mockResolvedValue('bafy-new-cid'),
}));

// v1.1 guard returns false so the .fair re-sign path is skipped in tests.
vi.mock('@imajin/fair', async importOriginal => ({
  ...await importOriginal<typeof import('@imajin/fair')>(),
  isFairManifestV11: vi.fn(() => false),
}));

vi.mock('@/src/lib/media/content-signer', () => ({
  contentSigner: { sign: vi.fn() },
}));

vi.mock('@/src/lib/media/blob-store-lore', () => ({
  blobStore: { put: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/src/lib/media/write-access', () => ({
  canWriteAssetContent: vi.fn(() => ({ allowed: true })),
}));

// Keep the real projection helpers (article-guard consumes
// projectArticleFromFrontmatter) and stub only the DB-writing derive step.
vi.mock('../article-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../article-core')>()),
  deriveArticleProjection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  // update-asset now registers the #1207 project reactor before publishing;
  // stub registerReactor so ensureProjectReactorRegistered() is a no-op here.
  registerReactor: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { publish } from '@imajin/bus';
import { writeFile } from 'node:fs/promises';
import { isFairManifestV11 } from '@imajin/fair';
import { contentSigner } from '@/src/lib/media/content-signer';
import { sql } from 'drizzle-orm';

// ─── Helpers ───────────────────────────────────────────────────────────────

function setupAsset(overrides: Record<string, unknown> = {}) {
  const asset = {
    id: 'asset_test',
    ownerDid: 'did:imajin:owner',
    status: 'active',
    mimeType: 'text/markdown',
    storagePath: '/mnt/media/did_imajin_owner/assets/asset_test.md',
    immutable: false,
    fairManifest: {},
    fairPath: null,
    cid: 'bafy-old-cid',
    loreRef: 'lore-old',
    versionCount: 1,
    metadata: {},
    ...overrides,
  };

  // Both the initial load and the final re-select resolve to the asset.
  mockLimit.mockResolvedValue([asset]);
  return asset;
}

beforeEach(() => {
  vi.clearAllMocks();
  legalMocks.prepare.mockResolvedValue({ id: 'att_legal', signature: 'fixture-signature' });
});

describe('updateAssetContent — per-DID locking', () => {
  it.each([{}, { kind: 'legal-entity' }])('waits for the settings lock before updating metadata %j', async metadata => {
    setupAsset({ ownerDid, metadata });
    vi.mocked(contentSigner.sign).mockImplementation(async manifest => manifest);
    let releaseLock!: () => void;
    let reachedLock!: () => void;
    const blocked = new Promise<void>(resolve => { releaseLock = resolve; });
    const waiting = new Promise<void>(resolve => { reachedLock = resolve; });
    mockExecute.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      reachedLock();
      await blocked;
    });
    const order: string[] = [];
    const settings = withAssetContentLock(ownerDid, async () => {
      order.push('settings');
      await blocked;
      order.push('settings finished');
    });
    const update = updateAssetContent({
      assetId: 'asset_test', requesterDid: ownerDid,
      content: composeLegalEntity(ownerDid, legalEntityFixture()),
      ...(metadata.kind ? { controlDocument: 'legal-entity' as const } : {}),
    }).then(result => { order.push('media finished'); return result; });
    await waiting;
    expect(writeFile).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(vi.mocked(sql).mock.calls.filter(call => call[1] === `legal-entity:${ownerDid}`)).toHaveLength(2);
    releaseLock();
    await settings;
    expect((await update).ok).toBe(true);
    expect(order).toEqual(['settings', 'settings finished', 'media finished']);
  });
  it('lets the settings writer update under its existing lock without reacquiring it', async () => {
    setupAsset({ ownerDid });
    const result = await withAssetContentLock(ownerDid, update => update({
      assetId: 'asset_test', requesterDid: ownerDid, content: '# settings',
    }));
    expect(result.ok).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });
  it.each(['deleted', 'owner-changed'])('rechecks %s after acquiring the lock', async change => {
    const asset = setupAsset({ ownerDid });
    mockLimit.mockResolvedValueOnce([asset]).mockResolvedValueOnce([{
      ...asset, ...(change === 'deleted' ? { status: 'deleted' } : { ownerDid: 'different-owner' }),
    }]);
    expect(await updateAssetContent({ assetId: asset.id, requesterDid: ownerDid, content: '# stale' }))
      .toMatchObject({ ok: false, code: change === 'deleted' ? 'not_found' : 'forbidden' });
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('does not write if the advisory lock cannot be acquired', async () => {
    setupAsset({ ownerDid });
    mockExecute.mockRejectedValueOnce(new Error('lock unavailable'));
    await expect(updateAssetContent({ assetId: 'asset_test', requesterDid: ownerDid, content: '# denied' }))
      .rejects.toThrow('lock unavailable');
    expect(writeFile).not.toHaveBeenCalled();
  });
});
describe('updateAssetContent — legal control document', () => {
  function input(content = composeLegalEntity(ownerDid, legalEntityFixture())) {
    return { assetId: 'asset_test', requesterDid: ownerDid, composedBy: 'actual-human', content, controlDocument: 'legal-entity' as const };
  }
  function asset() {
    return setupAsset({ ownerDid, immutable: true, metadata: { kind: 'legal-entity' }, hash: 'old-hash' });
  }
  it('blocks generic media writes even for the owner', async () => {
    asset();
    expect(await updateAssetContent({ ...input(), controlDocument: undefined })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('preserves the canonical owner boundary even on the internal settings rail', async () => {
    asset();
    vi.mocked(canWriteAssetContent).mockReturnValueOnce({ allowed: false, code: 'forbidden', reason: 'Not owner' });
    expect(await updateAssetContent({ ...input(), requesterDid: 'unrelated' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('rejects malformed or oversized source documents without modifying storage', async () => {
    asset();
    for (const content of ['invalid', 'a'.repeat(16385)]) {
      expect(await updateAssetContent(input(content))).toMatchObject({ ok: false, code: 'invalid_document' });
    }
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('refuses unsigned saves before writing any bytes', async () => {
    asset();
    vi.mocked(contentSigner.sign).mockRejectedValueOnce(new Error('unavailable'));
    expect(await updateAssetContent(input())).toMatchObject({ ok: false, code: 'signing_failed' });
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('requires a durable change attestation before writing any bytes', async () => {
    asset();
    vi.mocked(contentSigner.sign).mockImplementationOnce(async manifest => manifest);
    legalMocks.prepare.mockRejectedValueOnce(new Error('attestation unavailable'));
    expect(await updateAssetContent(input())).toMatchObject({ ok: false, code: 'signing_failed' });
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('writes a signed tombstone, retained deleted row, and attestation before document.changed', async () => {
    asset();
    vi.mocked(contentSigner.sign).mockImplementationOnce(async manifest => manifest);
    const result = await updateAssetContent(input(composeLegalEntityRevocation(ownerDid)));
    expect(result.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'deleted' }));
    expect(legalMocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      type: 'document.amended', payload: expect.objectContaining({ operation: 'revoke', previousHash: 'old-hash', composedBy: 'actual-human' }),
    }));
    expect(mockAttestationValues).toHaveBeenCalledWith(expect.objectContaining({ id: 'att_legal' }));
    expect(publish).toHaveBeenCalledWith('document.changed', expect.objectContaining({
      issuer: ownerDid, subject: 'asset_test', payload: expect.objectContaining({ prevCid: 'bafy-old-cid' }),
    }));
  });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('updateAssetContent — document.changed trigger (#1205)', () => {
  it('publishes exactly one document.changed for an authored-markdown write', async () => {
    setupAsset({ mimeType: 'text/markdown' });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: '# Hello',
    });

    expect(result.ok).toBe(true);

    const changedCalls = vi
      .mocked(publish)
      .mock.calls.filter(([type]) => type === 'document.changed');
    expect(changedCalls).toHaveLength(1);

    expect(publish).toHaveBeenCalledWith('document.changed', {
      issuer: 'did:imajin:owner',
      subject: 'asset_test',
      scope: 'media',
      payload: {
        path: '/mnt/media/did_imajin_owner/assets/asset_test.md',
        cid: 'bafy-new-cid',
        prevCid: 'bafy-old-cid',
      },
    });
  });

  it('reports prevCid as null when the asset had no prior CID', async () => {
    setupAsset({ mimeType: 'application/yaml', cid: null });

    await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: 'key: value',
    });

    expect(publish).toHaveBeenCalledWith(
      'document.changed',
      expect.objectContaining({
        payload: expect.objectContaining({ prevCid: null, cid: 'bafy-new-cid' }),
      })
    );
  });

  it('does NOT fire document.changed for a non-authored (binary) write', async () => {
    setupAsset({ mimeType: 'image/png' });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: 'not really an image',
    });

    expect(result.ok).toBe(true);

    const changedCalls = vi
      .mocked(publish)
      .mock.calls.filter(([type]) => type === 'document.changed');
    expect(changedCalls).toHaveLength(0);
  });
});

// ─── #1542 — article frontmatter guard ─────────────────────────────────────

const LIVE_ARTICLE = { article: { slug: 'hello', title: 'Hello', status: 'POSTED', date: '2026-08-01' } };
const HEADERLESS = '# Newsletter\n\nNo YAML header here.\n';
const WITH_HEADER =
  '---\nslug: "hello"\ntitle: "Hello"\nstatus: "POSTED"\ndate: "2026-08-01"\n---\n\n# Hello\n';

describe('updateAssetContent — article frontmatter guard (#1542)', () => {
  it('warns that a headerless write DEMOTES a live article', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(true);
    expect(result.articleWarning?.reason).toBe('missing_frontmatter');
    expect(result.articleWarning?.warning).toContain('DEMOTION');
    // Default is warn-only: the content is still written.
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('warns for an article-context asset that never had a projection', async () => {
    setupAsset({ metadata: { context: { app: 'article' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(false);
    expect(result.articleWarning?.warning).toContain('will NOT render as an article');
  });

  it('does NOT warn for a plain note (no article intent)', async () => {
    setupAsset({ metadata: {} });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('does NOT warn when the new content keeps valid frontmatter', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: WITH_HEADER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('hard-rejects under strict, without writing anything', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('article_frontmatter_required');
    expect(writeFile).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('strict does not block a plain-note write', async () => {
    setupAsset({ metadata: {} });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
      strict: true,
    });

    expect(result.ok).toBe(true);
  });
});

// ─── #1870 — document-context markdown (silent lane) ───────────────────────

describe('updateAssetContent — document-context frontmatter guard (#1870)', () => {
  it('warns for a document-context asset that never had a projection', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(false);
    expect(result.articleWarning?.reason).toBe('missing_frontmatter');
    // Default is warn-only: the content is still written.
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the new document-context content keeps valid frontmatter', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: WITH_HEADER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('hard-rejects a headerless document-context write under strict', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('article_frontmatter_required');
    expect(writeFile).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does NOT warn for note-context markdown (stays exempt)', async () => {
    setupAsset({ metadata: { context: { app: 'note' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });
});

// ─── .fair manifest re-sign (non-fatal at every step) ──────────────────────

describe('updateAssetContent — .fair manifest re-sign', () => {
  const MANIFEST = { version: '1.1', owner: 'did:imajin:owner' };
  const SIGNED = { ...MANIFEST, signature: 'sig-new' };

  beforeEach(() => {
    vi.mocked(isFairManifestV11).mockReturnValue(true);
  });

  afterEach(() => {
    vi.mocked(isFairManifestV11).mockReturnValue(false);
  });

  function writtenFairManifest() {
    const setCalls = mockSet.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return setCalls.at(-1)?.[0]?.fairManifest;
  }

  it('re-signs the manifest, mirrors it to the .fair path on disk, and stores the signed manifest', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(contentSigner.sign).toHaveBeenCalledWith(MANIFEST);
    expect(writeFile).toHaveBeenCalledWith('/mnt/media/asset_test.fair', JSON.stringify(SIGNED, null, 2));
    expect(writtenFairManifest()).toEqual(SIGNED);
  });

  it('re-signs without writing a .fair file when the asset has no fairPath', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: null });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);

    await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(vi.mocked(writeFile).mock.calls.some(([path]) => String(path).endsWith('.fair'))).toBe(false);
    expect(writtenFairManifest()).toEqual(SIGNED);
  });

  it('still stores the re-signed manifest when the .fair disk mirror fails (non-fatal)', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);
    vi.mocked(writeFile).mockImplementation(async (path) => {
      if (String(path).endsWith('.fair')) throw new Error('disk full');
    });

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(writtenFairManifest()).toEqual(SIGNED);
    vi.mocked(writeFile).mockReset();
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  it('keeps the previous manifest when signing throws (non-fatal)', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockRejectedValue(new Error('signer offline'));

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(writtenFairManifest()).toEqual(MANIFEST);
  });
});
