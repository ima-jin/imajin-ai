/**
 * Google Meet action library (#2144, v1).
 *
 * Read-only: lists conference records and their transcripts via the Meet REST
 * API (v2). Per the issue ("feed the media service transcribe→classify→sign
 * pipeline"), this module's job stops at the hand-off: `meet.transcript.available`
 * is the contract a media-pipeline reactor subscribes to, the same way
 * `drive.file.changed` doesn't itself run OCR. Wiring an actual reactor that
 * pulls the transcript into the media service is a follow-up, not connector
 * plumbing.
 */
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { requireGrantAndToken, googleApiFetch } from './connector';

const log = createLogger('kernel');

const MEET_API_BASE = 'https://meet.googleapis.com/v2';

function callMeetApi<T = unknown>(path: string, token: string): Promise<T> {
  return googleApiFetch<T>({ baseUrl: MEET_API_BASE, path, token, apiLabel: 'Meet' });
}

export interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
}

export interface ListConferenceRecordsResult {
  conferenceRecords: ConferenceRecord[];
  nextPageToken?: string;
}

/** List the caller's conference records (most recent first). */
export async function listConferenceRecords(
  ownerDid: string,
  options: { pageSize?: number; pageToken?: string } = {},
): Promise<ListConferenceRecordsResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:meet:records');
  const params = new URLSearchParams();
  if (options.pageSize) params.set('pageSize', String(Math.min(options.pageSize, 100)));
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const data = await callMeetApi<{ conferenceRecords?: ConferenceRecord[]; nextPageToken?: string }>(
    `/conferenceRecords?${params.toString()}`,
    token,
  );
  return { conferenceRecords: data.conferenceRecords ?? [], nextPageToken: data.nextPageToken };
}

export interface Transcript {
  name: string;
  state?: string;
}

/**
 * List transcripts for a conference record and emit `meet.transcript.available`
 * for each one that has finished generating (`state === 'ENDED'`), so a
 * downstream reactor can pick it up for the media transcribe→classify→sign
 * pipeline.
 */
export async function listTranscripts(ownerDid: string, conferenceRecordId: string): Promise<Transcript[]> {
  const token = await requireGrantAndToken(ownerDid, 'google:meet:records');
  const data = await callMeetApi<{ transcripts?: Transcript[] }>(
    `/conferenceRecords/${encodeURIComponent(conferenceRecordId)}/transcripts`,
    token,
  );
  const transcripts = data.transcripts ?? [];

  for (const transcript of transcripts) {
    if (transcript.state !== 'ENDED') continue;
    try {
      await publish('meet.transcript.available', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'google',
        payload: {
          ownerDid,
          onBehalfOf: ownerDid,
          conferenceRecordId,
          transcriptId: transcript.name,
          context_id: transcript.name,
          context_type: 'google',
        },
      });
    } catch (err) {
      log.error({ err: String(err), transcriptId: transcript.name }, 'meet.transcript.available publish failed (non-fatal)');
    }
  }

  return transcripts;
}
