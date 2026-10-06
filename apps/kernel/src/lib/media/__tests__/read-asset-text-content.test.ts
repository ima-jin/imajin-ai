/**
 * #2565 — `readAssetTextContent` awaits the file read before returning
 * (typescript:S7503); a missing file still rejects the caller's promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock('node:fs/promises', () => ({ readFile: readFileMock, default: { readFile: readFileMock } }));
vi.mock('@/src/db', () => ({
  db: {},
  assets: {},
  folders: {},
  assetFolders: {},
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
}));
vi.mock('../authorize-read', () => ({ authorizeAssetRead: vi.fn() }));

import { readAssetTextContent } from '../queries';

const ASSET = { storagePath: '/data/media/notes.txt' } as never;

beforeEach(() => {
  readFileMock.mockReset();
});

describe('readAssetTextContent', () => {
  it('resolves with the UTF-8 content read from the asset storage path', async () => {
    readFileMock.mockResolvedValue('hello, world');

    await expect(readAssetTextContent(ASSET)).resolves.toBe('hello, world');
    expect(readFileMock).toHaveBeenCalledWith('/data/media/notes.txt', 'utf-8');
  });

  it('rejects when the file cannot be read', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(readAssetTextContent(ASSET)).rejects.toThrow('ENOENT');
  });
});
