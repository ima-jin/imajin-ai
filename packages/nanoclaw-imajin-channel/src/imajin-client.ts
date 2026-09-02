/**
 * Low-level Imajin chat client (imajin-ai#1932): WS inbound-frame helpers and
 * the outbound `POST /chat/api/d/:did/messages` call, modeled on
 * `openclaw-imajin-plugin/src/ws-service.ts` + `src/chat.ts` (a separate
 * repo/package — this is a new implementation of the same protocol, not an
 * import).
 */
import { authenticate, type ChallengeResponseConfig } from './auth/challenge-response.js';

export interface ChatMessageFrame {
  type: 'chat_message';
  conversationDid: string;
  message: {
    id: string;
    fromDid: string;
    content: unknown;
    createdAt: string;
  };
}

type InboundFrame = ChatMessageFrame | { type: string; [key: string]: unknown };

/**
 * Parse one inbound WS frame. Returns `null` for heartbeat/empty frames and
 * anything that isn't a JSON object with a string `type` — callers should
 * log-and-ignore on `null`, never throw, so a malformed frame can never
 * crash the socket (same discipline as the reference `ws-service.ts`).
 */
export function parseFrame(raw: string): InboundFrame | null {
  if (raw === '' || raw === 'pong') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    return null;
  }
  return parsed as InboundFrame;
}

/** Narrow an inbound frame to a well-formed `chat_message` frame. */
export function isChatMessageFrame(frame: InboundFrame): frame is ChatMessageFrame {
  if (frame.type !== 'chat_message') return false;
  const f = frame as Partial<ChatMessageFrame>;
  return (
    typeof f.conversationDid === 'string' &&
    !!f.message &&
    typeof f.message === 'object' &&
    typeof (f.message as { id?: unknown }).id === 'string' &&
    typeof (f.message as { fromDid?: unknown }).fromDid === 'string'
  );
}

/** True for the kernel's `auth_required` control frame or an auth-flavored `error` frame. */
export function isAuthFailureFrame(frame: InboundFrame): boolean {
  if (frame.type === 'auth_required') return true;
  if (frame.type !== 'error') return false;
  const message = (frame as { message?: unknown }).message;
  return typeof message === 'string' && /auth/i.test(message);
}

export interface SendMessageConfig extends ChallengeResponseConfig {
  fetchImpl?: typeof fetch;
}

export interface SentChatMessage {
  id: string;
  [key: string]: unknown;
}

/**
 * Send a text reply to a conversation, authenticated as the agent's own
 * session. Deliberately never sets `X-Acting-For` / `onBehalfOf` — the agent
 * replies as itself, which is structurally identical to `onBehalfOf: "self"`
 * (imajin-ai#1545): no delegation header is ever constructed by this client.
 */
export async function sendChatMessage(
  config: SendMessageConfig,
  conversationDid: string,
  text: string,
  replyToMessageId?: string,
): Promise<SentChatMessage> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const session = await authenticate(config, fetchImpl);

  const body: Record<string, unknown> = { content: { type: 'text', text }, contentType: 'text' };
  if (replyToMessageId) body.replyToMessageId = replyToMessageId;

  const res = await fetchImpl(
    `${config.kernelBaseUrl.replace(/\/+$/, '')}/chat/api/d/${encodeURIComponent(conversationDid)}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie,
        // No X-Acting-For header — see doc comment above.
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`chat send failed: ${res.status} ${errBody.error ?? res.statusText}`);
  }
  const { message } = (await res.json()) as { message: SentChatMessage };
  return message;
}
