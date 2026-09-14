/**
 * MCP Google Drive connector tools (#2144, v1). All requiredScope: 'google:drive:read'.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { listFiles, getFile, getFileContent, listChanges } from '@/src/lib/google/drive';

const listFilesTool: McpTool = {
  name: 'google_drive_list_files',
  requiredScope: 'google:drive:read',
  description:
    'List your Google Drive files, optionally filtered by Drive query syntax (e.g. "name contains \'deck\'"). ' +
    'Requires an active google:drive:read grant.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Drive query syntax' },
      pageSize: { type: 'number', description: 'Max files to return (default 20, ceiling 1000)' },
      pageToken: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const result = await listFiles(ctx.did, {
      query: str(args, 'query'),
      pageSize: num(args, 'pageSize'),
      pageToken: str(args, 'pageToken'),
    });
    return json(result);
  },
};

const getFileTool: McpTool = {
  name: 'google_drive_get_file',
  requiredScope: 'google:drive:read',
  description: 'Get metadata for one Drive file by id. Requires an active google:drive:read grant.',
  inputSchema: {
    type: 'object',
    properties: { fileId: { type: 'string' } },
    required: ['fileId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const fileId = str(args, 'fileId');
    if (fileId === undefined) throw new Error('fileId is required');
    return json(await getFile(ctx.did, fileId));
  },
};

const getFileContentTool: McpTool = {
  name: 'google_drive_get_file_content',
  requiredScope: 'google:drive:read',
  description:
    'Read a text-ish Drive file\u2019s content (capped at 2MB \u2014 use for docs/configs, not bulk file transfer). ' +
    'Requires an active google:drive:read grant.',
  inputSchema: {
    type: 'object',
    properties: { fileId: { type: 'string' } },
    required: ['fileId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const fileId = str(args, 'fileId');
    if (fileId === undefined) throw new Error('fileId is required');
    return json(await getFileContent(ctx.did, fileId));
  },
};

const listChangesTool: McpTool = {
  name: 'google_drive_list_changes',
  requiredScope: 'google:drive:read',
  description:
    'List Drive changes since the last call (cursor stored server-side per-DID) and emit a signed ' +
    'drive.file.changed event for each. The first call for a new connection starts the cursor and reports no ' +
    'changes; call again later for real deltas. Requires an active google:drive:read grant.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    return json(await listChanges(ctx.did));
  },
};

export const driveTools: McpTool[] = [listFilesTool, getFileTool, getFileContentTool, listChangesTool];
