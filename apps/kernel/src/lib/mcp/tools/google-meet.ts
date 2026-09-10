/**
 * MCP Google Meet connector tools (#2144, v1). All requiredScope: 'google:meet:records'.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { listConferenceRecords, listTranscripts } from '@/src/lib/google/meet';

const listConferenceRecordsTool: McpTool = {
  name: 'google_meet_list_conference_records',
  requiredScope: 'google:meet:records',
  description: 'List your Google Meet conference records (most recent first). Requires google:meet:records.',
  inputSchema: {
    type: 'object',
    properties: {
      pageSize: { type: 'number', description: 'Max records to return (default 20, ceiling 100)' },
      pageToken: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const result = await listConferenceRecords(ctx.did, {
      pageSize: num(args, 'pageSize'),
      pageToken: str(args, 'pageToken'),
    });
    return json(result);
  },
};

const listTranscriptsTool: McpTool = {
  name: 'google_meet_list_transcripts',
  requiredScope: 'google:meet:records',
  description:
    'List transcripts for a Meet conference record. Finished transcripts are announced as signed ' +
    'meet.transcript.available events for the media pipeline to pick up. Requires google:meet:records.',
  inputSchema: {
    type: 'object',
    properties: { conferenceRecordId: { type: 'string' } },
    required: ['conferenceRecordId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const conferenceRecordId = str(args, 'conferenceRecordId');
    if (conferenceRecordId === undefined) throw new Error('conferenceRecordId is required');
    return json(await listTranscripts(ctx.did, conferenceRecordId));
  },
};

export const meetTools: McpTool[] = [listConferenceRecordsTool, listTranscriptsTool];
