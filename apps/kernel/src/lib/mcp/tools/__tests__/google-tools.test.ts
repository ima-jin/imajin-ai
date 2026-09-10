import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  listThreadsMock, getMessageMock, sendMessageMock, watchMock,
  listEventsMock, getFreeBusyMock, createEventMock,
  listFilesMock, getFileMock, getFileContentMock, listChangesMock,
  listConferenceRecordsMock, listTranscriptsMock,
} = vi.hoisted(() => ({
  listThreadsMock: vi.fn(), getMessageMock: vi.fn(), sendMessageMock: vi.fn(), watchMock: vi.fn(),
  listEventsMock: vi.fn(), getFreeBusyMock: vi.fn(), createEventMock: vi.fn(),
  listFilesMock: vi.fn(), getFileMock: vi.fn(), getFileContentMock: vi.fn(), listChangesMock: vi.fn(),
  listConferenceRecordsMock: vi.fn(), listTranscriptsMock: vi.fn(),
}));

vi.mock('@/src/lib/google/gmail', () => ({
  listThreads: listThreadsMock, getMessage: getMessageMock, sendMessage: sendMessageMock, watch: watchMock,
}));
vi.mock('@/src/lib/google/calendar', () => ({
  listEvents: listEventsMock, getFreeBusy: getFreeBusyMock, createEvent: createEventMock,
}));
vi.mock('@/src/lib/google/drive', () => ({
  listFiles: listFilesMock, getFile: getFileMock, getFileContent: getFileContentMock, listChanges: listChangesMock,
}));
vi.mock('@/src/lib/google/meet', () => ({
  listConferenceRecords: listConferenceRecordsMock, listTranscripts: listTranscriptsMock,
}));

import { gmailTools } from '../google-gmail';
import { calendarTools } from '../google-calendar';
import { driveTools } from '../google-drive';
import { meetTools } from '../google-meet';

const CTX = { did: 'did:imajin:jin', appDid: 'did:imajin:mcp-connector', scopes: new Set<string>() };

beforeEach(() => {
  vi.clearAllMocks();
});

// Registration in `ALL_TOOLS` (tools/index.ts) is intentionally NOT exercised
// here: importing the real registry pulls in every sibling tool module's own
// DB-backed import graph unmocked (the pattern `scope-gate.test.ts` avoids by
// mocking `../tools` entirely). Registration is a one-line, code-reviewed
// `import` + array-spread in `index.ts` rather than logic worth a runtime test.
describe('google_* tool identity', () => {
  it('has no duplicate tool names across gmail/calendar/drive/meet', () => {
    const names = [...gmailTools, ...calendarTools, ...driveTools, ...meetTools].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('gmailTools', () => {
  it('gates list/get/watch on google:gmail:read and send on google:gmail:send', () => {
    const byName = Object.fromEntries(gmailTools.map((t) => [t.name, t]));
    expect(byName.google_gmail_list_threads.requiredScope).toBe('google:gmail:read');
    expect(byName.google_gmail_get_message.requiredScope).toBe('google:gmail:read');
    expect(byName.google_gmail_watch.requiredScope).toBe('google:gmail:read');
    expect(byName.google_gmail_send.requiredScope).toBe('google:gmail:send');
  });

  it('list_threads delegates to the action library with ctx.did', async () => {
    listThreadsMock.mockResolvedValue({ threads: [] });
    const tool = gmailTools.find((t) => t.name === 'google_gmail_list_threads')!;
    await tool.handler({ query: 'is:unread' }, CTX);
    expect(listThreadsMock).toHaveBeenCalledWith(CTX.did, expect.objectContaining({ query: 'is:unread' }));
  });

  it('send rejects when required args are missing, without calling the action library', async () => {
    const tool = gmailTools.find((t) => t.name === 'google_gmail_send')!;
    await expect(tool.handler({ to: 'a@b.com' }, CTX)).rejects.toThrow(/required/);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed revoked-grant error from the action library unchanged', async () => {
    listThreadsMock.mockRejectedValue(new Error('google_credential_revoked: reconnect via /google/api/connect'));
    const tool = gmailTools.find((t) => t.name === 'google_gmail_list_threads')!;
    await expect(tool.handler({}, CTX)).rejects.toThrow(/google_credential_revoked/);
  });
});

describe('calendarTools', () => {
  it('gates reads on google:calendar:read and create on google:calendar:write', () => {
    const byName = Object.fromEntries(calendarTools.map((t) => [t.name, t]));
    expect(byName.google_calendar_list_events.requiredScope).toBe('google:calendar:read');
    expect(byName.google_calendar_free_busy.requiredScope).toBe('google:calendar:read');
    expect(byName.google_calendar_create_event.requiredScope).toBe('google:calendar:write');
  });

  it('create_event delegates to the action library', async () => {
    createEventMock.mockResolvedValue({ googleEventId: 'g1', calendarEntryId: 'cal_1' });
    const tool = calendarTools.find((t) => t.name === 'google_calendar_create_event')!;
    await tool.handler({ summary: 'Sync', startIso: 'a', endIso: 'b', withMeet: true }, CTX);
    expect(createEventMock).toHaveBeenCalledWith(CTX.did, expect.objectContaining({ summary: 'Sync', withMeet: true }));
  });
});

describe('driveTools', () => {
  it('gates every tool on google:drive:read', () => {
    for (const tool of driveTools) expect(tool.requiredScope).toBe('google:drive:read');
  });

  it('list_changes delegates with no args', async () => {
    listChangesMock.mockResolvedValue({ changes: [] });
    const tool = driveTools.find((t) => t.name === 'google_drive_list_changes')!;
    await tool.handler({}, CTX);
    expect(listChangesMock).toHaveBeenCalledWith(CTX.did);
  });
});

describe('meetTools', () => {
  it('gates every tool on google:meet:records', () => {
    for (const tool of meetTools) expect(tool.requiredScope).toBe('google:meet:records');
  });

  it('list_transcripts requires conferenceRecordId', async () => {
    const tool = meetTools.find((t) => t.name === 'google_meet_list_transcripts')!;
    await expect(tool.handler({}, CTX)).rejects.toThrow(/conferenceRecordId/);
    expect(listTranscriptsMock).not.toHaveBeenCalled();
  });
});
