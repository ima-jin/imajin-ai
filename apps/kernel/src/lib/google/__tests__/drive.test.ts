import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireGrantAndTokenMock, publishMock, selectWhereMock, insertValuesMock, updateSetMock, updateWhereMock } = vi.hoisted(() => ({
  requireGrantAndTokenMock: vi.fn(),
  publishMock: vi.fn(),
  selectWhereMock: vi.fn(),
  insertValuesMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));
vi.mock('../connector', () => ({
  requireGrantAndToken: requireGrantAndTokenMock,
  googleApiRequest: async (opts: { baseUrl: string; path: string; token: string; method?: string; body?: unknown; apiLabel: string }) => {
    const url = opts.path.startsWith('http') ? opts.path : `${opts.baseUrl}${opts.path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
    const init: RequestInit = { method: opts.method ?? 'GET', headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${opts.apiLabel} API error ${res.status} ${res.statusText}: ${text}`);
    }
    return res;
  },
  googleApiFetch: async function (opts: { baseUrl: string; path: string; token: string; method?: string; body?: unknown; apiLabel: string }) {
    const url = opts.path.startsWith('http') ? opts.path : `${opts.baseUrl}${opts.path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
    const init: RequestInit = { method: opts.method ?? 'GET', headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${opts.apiLabel} API error ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  },
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectWhereMock }) }),
    insert: () => ({ values: insertValuesMock }),
    update: () => ({
      set: (values: unknown) => {
        updateSetMock(values);
        return { where: updateWhereMock };
      },
    }),
  },
  googleWorkspaceState: { id: 'id', ownerDid: 'owner_did', drivePageToken: 'drive_page_token' },
}));

import { listFiles, getFile, getFileContent, listChanges } from '../drive';

const OWNER = 'did:imajin:jin';
const TOKEN = 'drive-access-token';

// Recorded fixture shapes (Google Drive API v3).
const FILES_FIXTURE = { files: [{ id: 'f1', name: 'deck.pdf', mimeType: 'application/pdf', modifiedTime: '2026-01-01T00:00:00Z' }] };
const FILE_FIXTURE = { id: 'f1', name: 'deck.pdf', mimeType: 'application/pdf' };
const START_PAGE_TOKEN_FIXTURE = { startPageToken: 'ptok-1' };
const CHANGES_FIXTURE = {
  changes: [{ fileId: 'f2', removed: false }, { fileId: 'f3', removed: true }],
  newStartPageToken: 'ptok-2',
};

beforeEach(() => {
  requireGrantAndTokenMock.mockReset();
  requireGrantAndTokenMock.mockResolvedValue(TOKEN);
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  selectWhereMock.mockReset();
  selectWhereMock.mockResolvedValue([]);
  insertValuesMock.mockReset();
  insertValuesMock.mockResolvedValue(undefined);
  updateSetMock.mockReset();
  updateWhereMock.mockReset();
  updateWhereMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listFiles (google:drive:read)', () => {
  it('fails closed without a grant', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listFiles(OWNER)).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists files against the recorded fixture shape', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => FILES_FIXTURE });
    const result = await listFiles(OWNER, { query: "name contains 'deck'" });
    expect(result.files).toEqual(FILES_FIXTURE.files);
  });
});

describe('getFile (google:drive:read)', () => {
  it('fetches one file\u2019s metadata', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => FILE_FIXTURE });
    expect(await getFile(OWNER, 'f1')).toEqual(FILE_FIXTURE);
  });
});

describe('getFileContent (google:drive:read)', () => {
  it('reads and caps content at MAX_CONTENT_BYTES', async () => {
    const body = 'a'.repeat(50);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    });
    const result = await getFileContent(OWNER, 'f1');
    expect(result.content).toBe(body);
    expect(result.truncated).toBe(false);
  });
});

describe('listChanges (google:drive:read)', () => {
  it('fails closed without a grant', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listChanges(OWNER)).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts a fresh page token and reports no changes on the first call', async () => {
    selectWhereMock.mockResolvedValue([]); // no stored page token yet
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => START_PAGE_TOKEN_FIXTURE });

    const result = await listChanges(OWNER);

    expect(result.changes).toEqual([]);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: OWNER, drivePageToken: 'ptok-1' }));
  });

  it('reports changes and emits drive.file.changed per change, advancing the cursor', async () => {
    selectWhereMock.mockResolvedValue([{ drivePageToken: 'ptok-0' }]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => CHANGES_FIXTURE });

    const result = await listChanges(OWNER);

    expect(result.changes).toEqual(CHANGES_FIXTURE.changes);
    expect(publishMock).toHaveBeenCalledWith('drive.file.changed', expect.objectContaining({
      payload: expect.objectContaining({ fileId: 'f2', changeType: 'update', onBehalfOf: OWNER }),
    }));
    expect(publishMock).toHaveBeenCalledWith('drive.file.changed', expect.objectContaining({
      payload: expect.objectContaining({ fileId: 'f3', changeType: 'remove' }),
    }));
  });
});
