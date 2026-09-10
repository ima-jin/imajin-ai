/**
 * Google Drive action library (#2144, v1).
 *
 * File metadata/content reads are plain on-demand REST calls. Change
 * notifications ("deck v7 replaced v6 = event") are surfaced via an on-demand
 * `google_drive_list_changes` tool backed by Drive's own `changes.list`
 * cursor, rather than a second push pipeline — the issue is explicit about
 * push only for Gmail; Drive's own change feed is naturally poll-shaped and
 * cheap to call on demand.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, googleWorkspaceState } from '@/src/db';
import { generateId } from '../kernel/id';
import { requireGrantAndToken, googleApiFetch, googleApiRequest } from './connector';

const log = createLogger('kernel');

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

interface DriveApiOptions {
  path: string;
  token: string;
}

function callDriveApi<T = unknown>(opts: Readonly<DriveApiOptions>): Promise<T> {
  return googleApiFetch<T>({ ...opts, baseUrl: DRIVE_API_BASE, apiLabel: 'Drive' });
}

// ── Read tools (google:drive:read) ───────────────────────────────────────────

export interface DriveFileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
}

export interface ListFilesResult {
  files: DriveFileMetadata[];
  nextPageToken?: string;
}

/** List files, optionally filtered by Drive query syntax (`q`). */
export async function listFiles(
  ownerDid: string,
  options: { query?: string; pageSize?: number; pageToken?: string } = {},
): Promise<ListFilesResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:drive:read');
  const params = new URLSearchParams({ fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)' });
  if (options.query) params.set('q', options.query);
  if (options.pageSize) params.set('pageSize', String(Math.min(options.pageSize, 1000)));
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const data = await callDriveApi<{ files?: DriveFileMetadata[]; nextPageToken?: string }>({
    path: `/files?${params.toString()}`,
    token,
  });
  return { files: data.files ?? [], nextPageToken: data.nextPageToken };
}

/** Fetch one file's metadata. */
export async function getFile(ownerDid: string, fileId: string): Promise<DriveFileMetadata> {
  const token = await requireGrantAndToken(ownerDid, 'google:drive:read');
  return callDriveApi<DriveFileMetadata>({
    path: `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,size`,
    token,
  });
}

/** Cap on file content read back through this tool, in bytes. */
const MAX_CONTENT_BYTES = 2_000_000;

/**
 * Fetch a text-ish file's content, capped at {@link MAX_CONTENT_BYTES}.
 * Binary/large files should be listed via `getFile` and read some other way —
 * this tool exists for the "read a doc/config the agent needs" case, not bulk
 * file transfer.
 */
export async function getFileContent(ownerDid: string, fileId: string): Promise<{ content: string; truncated: boolean }> {
  const token = await requireGrantAndToken(ownerDid, 'google:drive:read');
  // Raw request, not googleApiFetch: this is the one call across all four
  // action libraries that needs the response body, not its JSON parse.
  const res = await googleApiRequest({
    baseUrl: DRIVE_API_BASE,
    path: `/files/${encodeURIComponent(fileId)}?alt=media`,
    token,
    apiLabel: 'Drive',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const truncated = buf.byteLength > MAX_CONTENT_BYTES;
  return { content: buf.subarray(0, MAX_CONTENT_BYTES).toString('utf-8'), truncated };
}

// ── Change feed (google:drive:read) ──────────────────────────────────────────

async function readStoredPageToken(ownerDid: string): Promise<string | undefined> {
  const rows = await db
    .select({ drivePageToken: googleWorkspaceState.drivePageToken })
    .from(googleWorkspaceState)
    .where(eq(googleWorkspaceState.ownerDid, ownerDid));
  return rows[0]?.drivePageToken ?? undefined;
}

async function storePageToken(ownerDid: string, pageToken: string): Promise<void> {
  const existing = await db
    .select({ id: googleWorkspaceState.id })
    .from(googleWorkspaceState)
    .where(eq(googleWorkspaceState.ownerDid, ownerDid));

  if (existing[0]) {
    await db
      .update(googleWorkspaceState)
      .set({ drivePageToken: pageToken, updatedAt: new Date() })
      .where(and(eq(googleWorkspaceState.ownerDid, ownerDid)));
  } else {
    await db.insert(googleWorkspaceState).values({
      id: generateId('gws'),
      ownerDid,
      drivePageToken: pageToken,
    });
  }
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFileMetadata;
}

export interface ListChangesResult {
  changes: DriveChange[];
}

/**
 * List Drive changes since the last call for this DID (cursor persisted in
 * `kernel.google_workspace_state`), emitting `drive.file.changed` for each and
 * advancing the stored cursor. The first call for a DID starts a fresh page
 * token (Drive has no "since the beginning" mode) and reports no changes —
 * every call after that reports genuine deltas.
 */
export async function listChanges(ownerDid: string): Promise<ListChangesResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:drive:read');

  const pageToken = await readStoredPageToken(ownerDid);
  if (!pageToken) {
    const start = await callDriveApi<{ startPageToken: string }>({ path: '/changes/startPageToken', token });
    await storePageToken(ownerDid, start.startPageToken);
    return { changes: [] };
  }

  const changes: DriveChange[] = [];
  let newStartPageToken: string | undefined;
  let cursor: string = pageToken;

  for (;;) {
    const params = new URLSearchParams({
      pageToken: cursor,
      fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, modifiedTime))',
    });
    const data = await callDriveApi<{
      changes?: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    }>({ path: `/changes?${params.toString()}`, token });

    changes.push(...(data.changes ?? []));
    if (data.newStartPageToken) newStartPageToken = data.newStartPageToken;
    const next: string | undefined = data.nextPageToken;
    if (!next) break;
    cursor = next;
  }

  for (const change of changes) {
    try {
      await publish('drive.file.changed', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'google',
        payload: {
          ownerDid,
          onBehalfOf: ownerDid,
          fileId: change.fileId,
          changeType: change.removed ? 'remove' : 'update',
          context_id: change.fileId,
          context_type: 'google',
        },
      });
    } catch (err) {
      log.error({ err: String(err), fileId: change.fileId }, 'drive.file.changed publish failed (non-fatal)');
    }
  }

  if (newStartPageToken) await storePageToken(ownerDid, newStartPageToken);

  return { changes };
}
