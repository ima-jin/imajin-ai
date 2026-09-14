/**
 * Gmail action library (#2144, v1).
 *
 * Read/send tools are plain on-demand REST calls, gated by
 * `requireGrantAndToken`. Push notifications are the exception the issue calls
 * out explicitly ("push via Pub/Sub users.watch — no polling"): {@link watch}
 * registers a Gmail `users.watch` push subscription, and
 * {@link processHistorySince} — called by the Pub/Sub webhook route — diffs
 * `users.history.list` and emits `mail.received` per newly-added message.
 *
 * Security invariants: every call is gated fail-closed by
 * `requireGrantAndToken`; the bearer token is only ever used in the
 * Authorization header, never logged or returned to a caller.
 */
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, googleWorkspaceState } from '@/src/db';
import { generateId } from '../kernel/id';
import { requireGrantAndToken, googleApiFetch } from './connector';

const log = createLogger('kernel');

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailApiOptions {
  method?: 'GET' | 'POST';
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

function callGmailApi<T = unknown>(opts: Readonly<GmailApiOptions>): Promise<T> {
  return googleApiFetch<T>({ ...opts, baseUrl: GMAIL_API_BASE, apiLabel: 'Gmail' });
}

// ── Read tools (google:gmail:read) ───────────────────────────────────────────

export interface GmailThreadSummary {
  id: string;
  snippet?: string;
  historyId?: string;
}

export interface GmailListThreadsResult {
  threads: GmailThreadSummary[];
  nextPageToken?: string;
}

/** List threads, optionally filtered by Gmail search syntax (`q`). */
export async function listThreads(
  ownerDid: string,
  options: { query?: string; maxResults?: number; pageToken?: string } = {},
): Promise<GmailListThreadsResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:gmail:read');
  const params = new URLSearchParams();
  if (options.query) params.set('q', options.query);
  if (options.maxResults) params.set('maxResults', String(Math.min(options.maxResults, 100)));
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const data = await callGmailApi<{ threads?: GmailThreadSummary[]; nextPageToken?: string }>({
    path: `/threads?${params.toString()}`,
    token,
  });
  return { threads: data.threads ?? [], nextPageToken: data.nextPageToken };
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: unknown;
  internalDate?: string;
}

/** Fetch one message by id. */
export async function getMessage(ownerDid: string, messageId: string): Promise<GmailMessage> {
  const token = await requireGrantAndToken(ownerDid, 'google:gmail:read');
  return callGmailApi<GmailMessage>({ path: `/messages/${encodeURIComponent(messageId)}`, token });
}

// ── Write tool (google:gmail:send) ───────────────────────────────────────────

/** Build an RFC 2822 message and base64url-encode it, per the Gmail send API. */
function buildRawMessage(to: string, subject: string, body: string): string {
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"'];
  const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;
  return Buffer.from(raw).toString('base64url');
}

export interface GmailSentMessage {
  id: string;
  threadId: string;
}

/**
 * Send an email on behalf of ownerDid (append tier — fail-closed on
 * `google:gmail:send`; sent-as is the connecting human, `onBehalfOf` recorded
 * on the emitted `mail.sent` event per the issue).
 */
export async function sendMessage(
  ownerDid: string,
  params: { to: string; subject: string; body: string },
): Promise<GmailSentMessage> {
  const token = await requireGrantAndToken(ownerDid, 'google:gmail:send');

  const data = await callGmailApi<GmailSentMessage>({
    method: 'POST',
    path: '/messages/send',
    token,
    body: { raw: buildRawMessage(params.to, params.subject, params.body) },
  });

  try {
    await publish('mail.sent', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'google',
      payload: {
        ownerDid,
        onBehalfOf: ownerDid,
        messageId: data.id,
        threadId: data.threadId,
        context_id: data.id,
        context_type: 'google',
      },
    });
  } catch (err) {
    log.error({ err: String(err), messageId: data.id }, 'mail.sent publish failed (non-fatal)');
  }

  return data;
}

// ── Push (google:gmail:read) — users.watch + history diff, #2144 ────────────

export interface GmailWatchResult {
  historyId: string;
  /** epoch ms — Google expires a watch after ~7 days. */
  expiration: number;
  emailAddress: string;
}

/** Upsert the persisted watch state for `ownerDid` in `google_workspace_state`. */
async function persistWatchState(ownerDid: string, result: Readonly<GmailWatchResult>): Promise<void> {
  const existing = await db
    .select({ id: googleWorkspaceState.id })
    .from(googleWorkspaceState)
    .where(eq(googleWorkspaceState.ownerDid, ownerDid));

  const fields = {
    gmailHistoryId: result.historyId,
    gmailWatchExpiration: new Date(result.expiration),
    gmailEmailAddress: result.emailAddress,
    updatedAt: new Date(),
  };

  if (existing[0]) {
    await db.update(googleWorkspaceState).set(fields).where(eq(googleWorkspaceState.ownerDid, ownerDid));
  } else {
    await db.insert(googleWorkspaceState).values({ id: generateId('gws'), ownerDid, ...fields });
  }
}

/**
 * Register (or renew) a Gmail push subscription against the configured
 * Pub/Sub topic. The issue is explicit that Gmail reads should be push, not
 * polled — this is the registration half; the webhook route and the renewal
 * cron (both in this PR) are the other two thirds.
 *
 * Persists the resulting historyId/expiration plus the mailbox's own address
 * (via `users.getProfile`) into `google_workspace_state`: Google's Pub/Sub
 * push payload names the mailbox by address, not by DID, so the webhook route
 * needs that reverse index to resolve which owner a push belongs to.
 */
export async function watch(ownerDid: string): Promise<GmailWatchResult> {
  const token = await requireGrantAndToken(ownerDid, 'google:gmail:read');
  const topicName = process.env.GOOGLE_GMAIL_PUBSUB_TOPIC;
  if (!topicName) {
    throw new Error('google_gmail_watch_unconfigured: GOOGLE_GMAIL_PUBSUB_TOPIC is not set');
  }

  const [watchData, profile] = await Promise.all([
    callGmailApi<{ historyId: string; expiration: string }>({
      method: 'POST',
      path: '/watch',
      token,
      body: { topicName, labelIds: ['INBOX'] },
    }),
    callGmailApi<{ emailAddress: string }>({ path: '/profile', token }),
  ]);

  const result: GmailWatchResult = {
    historyId: watchData.historyId,
    expiration: Number(watchData.expiration),
    emailAddress: profile.emailAddress,
  };
  await persistWatchState(ownerDid, result);
  return result;
}

/** Resolve the ownerDid a Gmail push notification's `emailAddress` belongs to, or undefined. */
export async function resolveOwnerByGmailAddress(emailAddress: string): Promise<string | undefined> {
  const rows = await db
    .select({ ownerDid: googleWorkspaceState.ownerDid })
    .from(googleWorkspaceState)
    .where(eq(googleWorkspaceState.gmailEmailAddress, emailAddress));
  return rows[0]?.ownerDid;
}

/** Read the last-seen historyId stored for `ownerDid`, or undefined. */
export async function readStoredHistoryId(ownerDid: string): Promise<string | undefined> {
  const rows = await db
    .select({ gmailHistoryId: googleWorkspaceState.gmailHistoryId })
    .from(googleWorkspaceState)
    .where(eq(googleWorkspaceState.ownerDid, ownerDid));
  return rows[0]?.gmailHistoryId ?? undefined;
}

/** Advance the stored historyId cursor for `ownerDid` after processing a push. */
export async function advanceHistoryId(ownerDid: string, historyId: string): Promise<void> {
  await db
    .update(googleWorkspaceState)
    .set({ gmailHistoryId: historyId, updatedAt: new Date() })
    .where(eq(googleWorkspaceState.ownerDid, ownerDid));
}

/** Every (ownerDid, watch expiration) pair with a live Gmail watch, for the renewal cron. */
export async function listWatchExpirations(): Promise<Array<{ ownerDid: string; expiration: Date | null }>> {
  return db
    .select({ ownerDid: googleWorkspaceState.ownerDid, expiration: googleWorkspaceState.gmailWatchExpiration })
    .from(googleWorkspaceState);
}

interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
}

/**
 * Diff Gmail's history feed since `startHistoryId` and emit `mail.received`
 * for every newly-added message. Called by the Pub/Sub push webhook with the
 * historyId Google's push notification carried.
 *
 * Returns the new highest historyId seen, so the caller can advance its
 * stored cursor — or `startHistoryId` unchanged if nothing new arrived.
 */
export async function processHistorySince(ownerDid: string, startHistoryId: string): Promise<string> {
  const token = await requireGrantAndToken(ownerDid, 'google:gmail:read');

  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
    if (pageToken) params.set('pageToken', pageToken);

    const data = await callGmailApi<{
      history?: GmailHistoryRecord[];
      historyId?: string;
      nextPageToken?: string;
    }>({ path: `/history?${params.toString()}`, token });

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        try {
          await publish('mail.received', {
            issuer: ownerDid,
            subject: ownerDid,
            scope: 'google',
            payload: {
              ownerDid,
              onBehalfOf: ownerDid,
              messageId: added.message.id,
              threadId: added.message.threadId,
              historyId: record.id,
              context_id: added.message.id,
              context_type: 'google',
            },
          });
        } catch (err) {
          log.error({ err: String(err), messageId: added.message.id }, 'mail.received publish failed (non-fatal)');
        }
      }
    }

    if (data.historyId) latestHistoryId = data.historyId;
    pageToken = data.nextPageToken;
  } while (pageToken);

  return latestHistoryId;
}
