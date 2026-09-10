import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Gmail action library tests (#2144) ─────────────────────────────────────
//
// No live Google calls: `requireGrantAndToken` is mocked to either resolve a
// fixed test token (granted path) or reject (fail-closed path), and `fetch`
// is stubbed with recorded Gmail REST API response shapes.

const { requireGrantAndTokenMock, publishMock, dbSelectWhereMock, dbInsertValuesMock, dbUpdateSetMock, dbUpdateWhereMock } = vi.hoisted(() => ({
  requireGrantAndTokenMock: vi.fn(),
  publishMock: vi.fn(),
  dbSelectWhereMock: vi.fn(),
  dbInsertValuesMock: vi.fn(),
  dbUpdateSetMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: (col: unknown, val: unknown) => ({ col, val }) }));
// googleApiFetch is the real shared implementation (#2144 review) — reimplemented
// here rather than partially importing the real module, since `requireGrantAndToken`
// still needs to be a plain mock and the two live in the same module.
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
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: dbSelectWhereMock }) }),
    insert: () => ({ values: dbInsertValuesMock }),
    update: () => ({
      set: (values: unknown) => {
        dbUpdateSetMock(values);
        return { where: dbUpdateWhereMock };
      },
    }),
  },
  googleWorkspaceState: { ownerDid: 'owner_did', gmailEmailAddress: 'gmail_email_address' },
}));

import { listThreads, getMessage, sendMessage, watch, resolveOwnerByGmailAddress, processHistorySince } from '../gmail';

const OWNER = 'did:imajin:jin';
const TOKEN = 'gmail-access-token';

// Recorded fixture shapes (Gmail REST API v1).
const THREADS_FIXTURE = {
  threads: [{ id: 't1', snippet: 'hello', historyId: '100' }],
  nextPageToken: undefined,
};
const MESSAGE_FIXTURE = { id: 'm1', threadId: 't1', snippet: 'hi', internalDate: '1700000000000' };
const SEND_FIXTURE = { id: 'm2', threadId: 't2' };
const WATCH_FIXTURE = { historyId: '200', expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) };
const PROFILE_FIXTURE = { emailAddress: 'jin@artifactads.com' };
const HISTORY_FIXTURE = {
  history: [{ id: '201', messagesAdded: [{ message: { id: 'm3', threadId: 't3' } }] }],
  historyId: '201',
};

beforeEach(() => {
  requireGrantAndTokenMock.mockReset();
  requireGrantAndTokenMock.mockResolvedValue(TOKEN);
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  dbSelectWhereMock.mockReset();
  dbSelectWhereMock.mockResolvedValue([]);
  dbInsertValuesMock.mockReset();
  dbInsertValuesMock.mockResolvedValue(undefined);
  dbUpdateSetMock.mockReset();
  dbUpdateWhereMock.mockReset();
  dbUpdateWhereMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
  process.env.GOOGLE_GMAIL_PUBSUB_TOPIC = 'projects/imajin/topics/gmail-push';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_GMAIL_PUBSUB_TOPIC;
});

describe('listThreads (google:gmail:read)', () => {
  it('fails closed without a grant, never calling the API', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(listThreads(OWNER)).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists threads against the recorded fixture shape', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => THREADS_FIXTURE });
    const result = await listThreads(OWNER, { query: 'is:unread' });
    expect(result.threads).toEqual(THREADS_FIXTURE.threads);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/threads?');
    expect(url).toContain('q=is%3Aunread');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('getMessage (google:gmail:read)', () => {
  it('fetches one message by id', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => MESSAGE_FIXTURE });
    expect(await getMessage(OWNER, 'm1')).toEqual(MESSAGE_FIXTURE);
  });
});

describe('sendMessage (google:gmail:send)', () => {
  it('fails closed without google:gmail:send, never calling the API', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_no_grant: nope'));
    await expect(sendMessage(OWNER, { to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends and emits mail.sent with onBehalfOf', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => SEND_FIXTURE });
    const result = await sendMessage(OWNER, { to: 'a@b.com', subject: 'Hi', body: 'Hello' });
    expect(result).toEqual(SEND_FIXTURE);
    expect(publishMock).toHaveBeenCalledWith('mail.sent', expect.objectContaining({
      issuer: OWNER,
      subject: OWNER,
      payload: expect.objectContaining({ onBehalfOf: OWNER, messageId: 'm2', threadId: 't2' }),
    }));
  });

  it('base64url-encodes the raw RFC 2822 message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => SEND_FIXTURE });
    await sendMessage(OWNER, { to: 'a@b.com', subject: 'Hi', body: 'Hello' });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const raw = (JSON.parse(init.body as string) as { raw: string }).raw;
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    expect(decoded).toContain('To: a@b.com');
    expect(decoded).toContain('Subject: Hi');
    expect(decoded).toContain('Hello');
  });
});

describe('watch (google:gmail:read, push registration)', () => {
  it('throws when GOOGLE_GMAIL_PUBSUB_TOPIC is unset', async () => {
    delete process.env.GOOGLE_GMAIL_PUBSUB_TOPIC;
    await expect(watch(OWNER)).rejects.toThrow(/google_gmail_watch_unconfigured/);
  });

  it('registers the watch and persists historyId/expiration/emailAddress', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => WATCH_FIXTURE })
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE_FIXTURE });

    const result = await watch(OWNER);

    expect(result.historyId).toBe('200');
    expect(result.emailAddress).toBe('jin@artifactads.com');
    expect(dbInsertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid: OWNER, gmailHistoryId: '200', gmailEmailAddress: 'jin@artifactads.com',
    }));
  });
});

describe('resolveOwnerByGmailAddress', () => {
  it('resolves the ownerDid for a known mailbox', async () => {
    dbSelectWhereMock.mockResolvedValue([{ ownerDid: OWNER }]);
    expect(await resolveOwnerByGmailAddress('jin@artifactads.com')).toBe(OWNER);
  });

  it('returns undefined for an unknown mailbox', async () => {
    dbSelectWhereMock.mockResolvedValue([]);
    expect(await resolveOwnerByGmailAddress('nobody@example.com')).toBeUndefined();
  });
});

describe('processHistorySince (webhook diff)', () => {
  it('emits mail.received for each newly-added message and returns the new cursor', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => HISTORY_FIXTURE });

    const latest = await processHistorySince(OWNER, '100');

    expect(latest).toBe('201');
    expect(publishMock).toHaveBeenCalledWith('mail.received', expect.objectContaining({
      payload: expect.objectContaining({ onBehalfOf: OWNER, messageId: 'm3', threadId: 't3', historyId: '201' }),
    }));
  });

  it('fails closed without a grant, never calling the API', async () => {
    requireGrantAndTokenMock.mockRejectedValue(new Error('google_credential_revoked: nope'));
    await expect(processHistorySince(OWNER, '100')).rejects.toThrow(/google_credential_revoked/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
