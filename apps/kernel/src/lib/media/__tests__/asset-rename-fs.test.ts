import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// #2681 — PATCH /media/api/assets/[id] used to join the user-supplied filename
// into the storage path and fs.rename onto it. These tests run against the REAL
// filesystem in a temp dir (node:fs/promises is NOT mocked); only the DB, auth,
// and logging seams are stubbed.

const mockAssetLimit = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetActiveAsset = vi.hoisted(() => vi.fn());

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockAssetLimit })) })) })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mockUpdateSet(values);
        return { where: mockUpdateWhere };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  },
  assets: {},
  assetReferences: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

import { createAuthMock, createNodeUrlMock, createLoggerMock } from './media-auth-test-helpers';

vi.mock('@imajin/auth', () => createAuthMock(vi.fn(async () => null)));
vi.mock('@/src/lib/http/node-url', () => createNodeUrlMock());
vi.mock('@imajin/logger', () => createLoggerMock());

// GET-side collaborators that need DB/network; the file read + response are real.
vi.mock('@/src/lib/media/queries', () => ({ getActiveAsset: mockGetActiveAsset }));
vi.mock('@/src/lib/media/resolve-manifest', () => ({
  resolveManifest: vi.fn(async () => ({ access: 'public' })),
  buildFairHeaders: vi.fn(() => ({})),
}));
vi.mock('@/src/lib/media/settle', () => ({
  determineAction: vi.fn(() => 'reproduction'),
  handleSettlement: vi.fn(async () => null),
}));

import { GET, PATCH } from '@/app/media/api/assets/[id]/route';

// ─── Fixture ───────────────────────────────────────────────────────────────

const ASSET_BYTES = 'the asset bytes';
const NEIGHBOUR_BYTES = "someone else's file";

let root: string;
let ownerDir: string;
let storagePath: string;
let neighbourPath: string;
let outsidePath: string;
let asset: Record<string, unknown>;

const params = Promise.resolve({ id: 'asset_test' });

function patch(filename: unknown): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  }) as unknown as NextRequest;
}

function get(): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test') as unknown as NextRequest;
}

/** Every file under root with its contents — proves nothing on disk moved. */
async function snapshot(dir: string = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(full));
    else out[path.relative(root, full)] = await readFile(full, 'utf8');
  }
  return out;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'rename-2681-'));
  ownerDir = path.join(root, 'did_imajin_owner', 'assets');
  await mkdir(ownerDir, { recursive: true });
  storagePath = path.join(ownerDir, 'asset_test.txt');
  neighbourPath = path.join(ownerDir, 'taken.txt');
  outsidePath = path.join(root, 'x');
  await writeFile(storagePath, ASSET_BYTES);
  await writeFile(neighbourPath, NEIGHBOUR_BYTES);

  asset = {
    id: 'asset_test',
    status: 'active',
    ownerDid: 'did:imajin:owner',
    immutable: false,
    filename: 'original.txt',
    mimeType: 'text/plain',
    hash: 'hash123',
    fairManifest: null,
    fairPath: null,
    fairDfosEventId: null,
    storagePath,
  };
  mockAssetLimit.mockResolvedValue([asset]);
  mockGetActiveAsset.mockResolvedValue(asset);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ─── Refused names ─────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id] — unsafe filenames are refused (#2681)', () => {
  const unsafe: Array<[string, () => string]> = [
    ['parent traversal (../x)', () => '../x'],
    ['deep parent traversal (../../x)', () => '../../x'],
    ['backslash traversal (..\\x)', () => '..\\x'],
    ['nested segment (a/b)', () => 'a/b'],
    ['absolute path', () => outsidePath],
    ['NUL byte', () => 'bad\0name.txt'],
    ['control character', () => 'bad\nname.txt'],
    ['dot', () => '.'],
    ['dot-dot', () => '..'],
    ['over-long name', () => 'a'.repeat(300)],
  ];

  it.each(unsafe)('returns 400 for %s and leaves every file untouched', async (_label, make) => {
    const before = await snapshot();

    const res = await PATCH(patch(make()), { params });

    expect(res.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-string filename', async () => {
    const before = await snapshot();

    const res = await PATCH(patch(42), { params });

    expect(res.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

// ─── Collision ─────────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id] — never overwrites a file on disk (#2681)', () => {
  it('renaming to the name of an existing sibling file leaves both files intact', async () => {
    const before = await snapshot();

    const res = await PATCH(patch('taken.txt'), { params });

    // Display-name-only rename: nothing on disk is touched, so the sibling
    // cannot be clobbered and the asset's own file does not move.
    expect(res.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(await readFile(neighbourPath, 'utf8')).toBe(NEIGHBOUR_BYTES);
    expect(await readFile(storagePath, 'utf8')).toBe(ASSET_BYTES);
    expect(mockUpdateSet).toHaveBeenCalledWith({ filename: 'taken.txt' });
  });
});

// ─── Normal rename ─────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id] — normal rename (#2681)', () => {
  it('updates only the display filename and keeps storagePath', async () => {
    const res = await PATCH(patch('  renamed notes.txt  '), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, filename: 'renamed notes.txt' });
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ filename: 'renamed notes.txt' });
    expect(Object.keys(mockUpdateSet.mock.calls[0][0] as object)).toEqual(['filename']);
  });

  it('accepts unicode and dotted names', async () => {
    const res = await PATCH(patch('résumé.v2.final.txt'), { params });

    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith({ filename: 'résumé.v2.final.txt' });
  });

  it('the asset still reads and streams after the rename', async () => {
    const renamed = await PATCH(patch('renamed.txt'), { params });
    expect(renamed.status).toBe(200);

    // Reflect the DB update the way the real row would after the rename.
    const [values] = mockUpdateSet.mock.calls[0] as [Record<string, unknown>];
    Object.assign(asset, values);

    const res = await GET(get(), { params });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe(ASSET_BYTES);
    expect(asset.storagePath).toBe(storagePath);
    expect(asset.filename).toBe('renamed.txt');
  });
});
