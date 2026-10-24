import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateCorpusOwner } from '../owner-migration';
import { resolveCorpusDid } from '../source-owner';
import { bootstrapCorpusIdentity, loadCorpusIdentity } from '../corpus-identity';

const mocks = vi.hoisted(() => ({
  transfer: vi.fn(), close: vi.fn(), construct: vi.fn(),
}));
vi.mock('../../engine/store', () => ({
  CorpusStore: vi.fn(function () {
    mocks.construct();
    return { transferSource: mocks.transfer, close: mocks.close };
  }),
}));
vi.mock('../source-owner', () => ({ resolveCorpusDid: vi.fn() }));
vi.mock('../attestation-key', () => ({ bootstrapAttestationInternalApiKey: vi.fn() }));
vi.mock('../corpus-identity', () => ({
  bootstrapCorpusIdentity: vi.fn(), loadCorpusIdentity: vi.fn(), markCorpusIdentityUsedForSigning: vi.fn(),
}));
const args = ['did:imajin:jin', 'github:ima-jin/imajin-ai', '--expect-owner', 'did:imajin:org'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCorpusDid).mockResolvedValue('did:imajin:org');
  vi.mocked(loadCorpusIdentity).mockReturnValue({ did: 'did:imajin:corpus', privateKey: 'unused-fixture' });
  mocks.transfer.mockReturnValue({ moved: 2 });
});
describe('offline owner migration preflight', () => {
  it.each([
    args.slice(0, 2), [...args.slice(0, 3)], [...args.slice(0, 3), '@org'],
    [args[0], 'local:workspace', ...args.slice(2)], [args[0], args[1], '--owner', args[3]], [...args, 'extra'],
  ].map(argv => ({ argv })))('requires an explicit expected owner and valid arguments: $argv', async ({ argv }) => {
    await expect(migrateCorpusOwner(argv)).rejects.toThrow('Usage:');
    expect(resolveCorpusDid).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it('refuses a mismatch before opening or changing either index', async () => {
    vi.mocked(resolveCorpusDid).mockResolvedValue('did:imajin:unexpected');
    await expect(migrateCorpusOwner(args)).rejects.toThrow('does not match');
    expect(resolveCorpusDid).toHaveBeenCalledWith(args[1], args[0], { createIfMissing: false });
    expect(bootstrapCorpusIdentity).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it('refuses a missing owner using read-only resolution, without creating any identity or opening an index', async () => {
    vi.mocked(resolveCorpusDid).mockRejectedValue(new Error('owner missing'));
    await expect(migrateCorpusOwner(args)).rejects.toThrow('owner missing');
    expect(resolveCorpusDid).toHaveBeenCalledWith(args[1], args[0], { createIfMissing: false });
    expect(bootstrapCorpusIdentity).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it('transfers only into the resolved, matching owner and returns identifiers/counts, never content', async () => {
    expect(await migrateCorpusOwner(args)).toEqual({
      source: args[1], fromDid: args[0], toDid: args[3], moved: 2,
    });
    expect(mocks.transfer).toHaveBeenCalledWith(args[0], args[3], args[1], expect.objectContaining({ did: 'did:imajin:corpus' }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('requires a signing identity and closes the store on a failed transfer', async () => {
    vi.mocked(loadCorpusIdentity).mockReturnValueOnce(null);
    await expect(migrateCorpusOwner(args)).rejects.toThrow('signing identity');
    expect(mocks.construct).not.toHaveBeenCalled();
    mocks.transfer.mockImplementationOnce(() => { throw new Error('collision'); });
    await expect(migrateCorpusOwner(args)).rejects.toThrow('collision');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
