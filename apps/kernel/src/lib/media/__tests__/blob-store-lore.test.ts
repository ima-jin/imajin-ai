import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockWaitAsync = vi.fn();
const mockFilterByType = vi.fn();
const mockCollectAsync = vi.fn();

const mockHandle = {
  waitAsync: mockWaitAsync,
  filterByType: mockFilterByType,
  collectAsync: mockCollectAsync,
};
mockFilterByType.mockReturnValue(mockHandle);

const mockLore = {
  logConfigure: vi.fn(),
  shutdown: vi.fn(),
  repositoryCreate: vi.fn(() => mockHandle),
  fileStage: vi.fn(() => mockHandle),
  revisionCommit: vi.fn(() => mockHandle),
};

vi.mock('@lore-vcs/sdk', () => ({ lore: mockLore }));
vi.mock('@lore-vcs/sdk/types/enums', () => ({
  LoreEventTag: { REVISION_COMMIT_REVISION: 'REVISION_COMMIT_REVISION' },
  LoreLogLevel: { WARN: 'WARN' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

// Fake the .lore directory check so we don't need a real filesystem
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),  // pretend .lore doesn't exist → triggers repositoryCreate
}));

// ─── Subject ───────────────────────────────────────────────────────────────

// Import AFTER mocks are registered
const { LoreBlobStore } = await import('../blob-store-lore');

// ─── Helpers ───────────────────────────────────────────────────────────────

const FAKE_REV = 'a'.repeat(64);
const OWNER_DID = 'did:imajin:owner123';
const FILE_PATH = '/mnt/media/did_imajin_owner123/assets/asset_abc.mp4';
const HINT = { assetId: 'asset_abc', sizeBytes: 512_000 };

function setupSuccessfulCommit(revision = FAKE_REV) {
  mockWaitAsync.mockResolvedValue(0);
  mockCollectAsync.mockResolvedValue([
    { tag: 'REVISION_COMMIT_REVISION', data: { revision } },
  ]);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('LoreBlobStore', () => {
  let store: InstanceType<typeof LoreBlobStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilterByType.mockReturnValue(mockHandle);
    store = new LoreBlobStore();
  });

  it('put returns a 64-char loreRef on success', async () => {
    setupSuccessfulCommit();

    const ref = await store.put(OWNER_DID, FILE_PATH, HINT);

    expect(ref.loreRef).toBe(FAKE_REV);
    expect(ref.loreRef).toHaveLength(64);
    expect(ref.sizeBytes).toBe(HINT.sizeBytes);
  });

  it('put calls repositoryCreate when .lore directory does not exist', async () => {
    setupSuccessfulCommit();

    await store.put(OWNER_DID, FILE_PATH, HINT);

    expect(mockLore.repositoryCreate).toHaveBeenCalledOnce();
    expect(mockLore.repositoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ offline: true }),
      expect.objectContaining({ repositoryUrl: expect.stringContaining('imajin-media') }),
    );
  });

  it('put skips repositoryCreate on second call for the same DID (in-process cache)', async () => {
    setupSuccessfulCommit();

    await store.put(OWNER_DID, FILE_PATH, HINT);
    await store.put(OWNER_DID, FILE_PATH, { ...HINT, assetId: 'asset_def' });

    // repositoryCreate should only be called once across both puts
    expect(mockLore.repositoryCreate).toHaveBeenCalledOnce();
  });

  it('put calls fileStage with the correct filePath', async () => {
    setupSuccessfulCommit();

    await store.put(OWNER_DID, FILE_PATH, HINT);

    expect(mockLore.fileStage).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryPath: expect.stringContaining('did_imajin_owner123') }),
      { paths: [FILE_PATH] },
    );
  });

  it('put includes assetId in the commit message', async () => {
    setupSuccessfulCommit();

    await store.put(OWNER_DID, FILE_PATH, HINT);

    expect(mockLore.revisionCommit).toHaveBeenCalledWith(
      expect.any(Object),
      { message: `upload: ${HINT.assetId}` },
    );
  });

  it('put throws when revision hash is missing from commit events', async () => {
    mockWaitAsync.mockResolvedValue(0);
    mockCollectAsync.mockResolvedValue([]);  // no REVISION_COMMIT_REVISION event

    await expect(store.put(OWNER_DID, FILE_PATH, HINT)).rejects.toThrow(
      'did not return a valid revision hash',
    );
  });

  it('put throws when revision hash is not 64 chars', async () => {
    mockWaitAsync.mockResolvedValue(0);
    mockCollectAsync.mockResolvedValue([
      { tag: 'REVISION_COMMIT_REVISION', data: { revision: 'tooshort' } },
    ]);

    await expect(store.put(OWNER_DID, FILE_PATH, HINT)).rejects.toThrow(
      'did not return a valid revision hash',
    );
  });

  it('put propagates errors so the upload route .catch() can handle them', async () => {
    mockWaitAsync.mockRejectedValue(new Error('Lore I/O error'));

    await expect(store.put(OWNER_DID, FILE_PATH, HINT)).rejects.toThrow('Lore I/O error');
  });

  it('serializes same-DID concurrent puts (queue concurrency=1)', async () => {
    const order: number[] = [];

    // Each put takes a different amount of time to complete
    mockLore.repositoryCreate.mockReturnValue(mockHandle);
    mockWaitAsync.mockImplementation(() => Promise.resolve(0));

    let call = 0;
    mockCollectAsync.mockImplementation(() => {
      const n = ++call;
      return new Promise(resolve =>
        setTimeout(() => {
          order.push(n);
          resolve([{ tag: 'REVISION_COMMIT_REVISION', data: { revision: FAKE_REV } }]);
        }, n === 1 ? 30 : 10)  // first put is slower
      );
    });

    // Fire both at the same time
    const [r1, r2] = await Promise.all([
      store.put(OWNER_DID, FILE_PATH, { ...HINT, assetId: 'asset_1' }),
      store.put(OWNER_DID, FILE_PATH, { ...HINT, assetId: 'asset_2' }),
    ]);

    // Both succeed
    expect(r1.loreRef).toBe(FAKE_REV);
    expect(r2.loreRef).toBe(FAKE_REV);
    // Serialized: 1 completes before 2 starts
    expect(order).toEqual([1, 2]);
  });

  it('runs different-DID puts concurrently (independent queues)', async () => {
    const completed: string[] = [];

    mockWaitAsync.mockResolvedValue(0);
    let call = 0;
    mockCollectAsync.mockImplementation(() => {
      const n = ++call;
      const did = n === 1 ? 'did:imajin:alice' : 'did:imajin:bob';
      return new Promise(resolve =>
        setTimeout(() => {
          completed.push(did);
          resolve([{ tag: 'REVISION_COMMIT_REVISION', data: { revision: FAKE_REV } }]);
        }, n === 1 ? 20 : 5)
      );
    });

    await Promise.all([
      store.put('did:imajin:alice', FILE_PATH, HINT),
      store.put('did:imajin:bob', FILE_PATH, HINT),
    ]);

    // bob (faster) should finish before alice (slower) — they ran concurrently
    expect(completed[0]).toBe('did:imajin:bob');
    expect(completed[1]).toBe('did:imajin:alice');
  });

  it('gc is a no-op and does not throw', async () => {
    await expect(store.gc(OWNER_DID, FAKE_REV)).resolves.toBeUndefined();
  });
});
