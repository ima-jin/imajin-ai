import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireGrantAndTokenMock, publishMock } = vi.hoisted(() => ({
  requireGrantAndTokenMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('../connector', () => ({
  requireGrantAndToken: requireGrantAndTokenMock,
  googleApiFetch: async (opts: { baseUrl: string; path: string; token: string; method?: string; body?: unknown; apiLabel: string }) => {
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

import { listConferenceRecords, listTranscripts } from '../meet';

const OWNER = 'did:imajin:jin';
const TOKEN = 'meet-access-token';

// Recorded fixture shapes (Google Meet REST API v2).
const RECORDS_FIXTURE = { conferenceRecords: [{ name: 'conferenceRecords/abc', startTime: '2026-01-01T10:00:00Z' }] };
const TRANSCRIPTS_FIXTURE = {
  transcripts: [
    { name: 'conferenceRecords/abc/transcripts/t1', state: 'ENDED' },
    { name: 'conferenceRecords/abc/transcripts/t2', state: 'IN_PROGRESS' },
  ],
};

beforeEach(() => {
  requireGrantAndTokenMock.mockReset();
  requireGrantAndTokenMock.mockResolvedValue(TOKEN);
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listConferenceRecords (google:meet:records)', () => {
  it('fails closed without a grant', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listConferenceRecords(OWNER)).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists conference records against the recorded fixture shape', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => RECORDS_FIXTURE });
    const result = await listConferenceRecords(OWNER);
    expect(result.conferenceRecords).toEqual(RECORDS_FIXTURE.conferenceRecords);
  });
});

describe('listTranscripts (google:meet:records)', () => {
  it('fails closed without a grant, never calling the API', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listTranscripts(OWNER, 'abc')).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('emits meet.transcript.available only for finished (ENDED) transcripts', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => TRANSCRIPTS_FIXTURE });

    const result = await listTranscripts(OWNER, 'abc');

    expect(result).toEqual(TRANSCRIPTS_FIXTURE.transcripts);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('meet.transcript.available', expect.objectContaining({
      payload: expect.objectContaining({
        onBehalfOf: OWNER, conferenceRecordId: 'abc', transcriptId: 'conferenceRecords/abc/transcripts/t1',
      }),
    }));
  });
});
