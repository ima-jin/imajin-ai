'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import {
  reachReplyEvent,
  type ReachReplySignature,
  type SignedReachReplyEvent,
} from '@/src/lib/auth/reach-reply-wire';
import { signReachReply } from './reach-reply-signing';
import type { ReachBearerKnock } from '@/src/lib/access/reach-bearer-wire';
import { ReachKnockCard } from './reach-knock-card';

type InboxEnvelope = ReachEnvelope & {
  reply?: SignedReachReplyEvent;
  replyPublishedAt?: string;
  blocked?: boolean;
  state?: string;
};

interface ReachInbox {
  principalDid: string;
  envelopes: InboxEnvelope[];
  knocks?: ReachBearerKnock[];
  actAs?: unknown;
}
function PendingReply({ reply, onPublished }: Readonly<{
  reply: SignedReachReplyEvent;
  onPublished: () => void;
}>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retrying = useRef(false);

  async function retry() {
    if (retrying.current) return;
    retrying.current = true;
    setPending(true);
    setError(null);
    try {
      const { reachId, message, issuedAt, signature } = reply.payload;
      await sendSignedReply(reachId, { message, issuedAt, signature });
      onPublished();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      retrying.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm text-amber-200">Reply signed — publication pending.</p>
      <button type="button" onClick={() => void retry()} disabled={pending}
        className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-40">
        {pending ? 'Retrying signed reply…' : 'Retry signed reply'}
      </button>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>
  );
}

interface SignedRequest {
  message: string;
  issuedAt: string;
  signature: ReachReplySignature;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to sign or send this reply. Please try again.';
}

async function responseError(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return `Reach request failed (${response.status}). Please try again.`;
}
async function sendSignedReply(reachId: string, signed: SignedRequest): Promise<SignedReachReplyEvent> {
  const response = await fetch(`/jin/api/reach/${encodeURIComponent(reachId)}/reply`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const body = await response.json() as { reply: SignedReachReplyEvent };
  return body.reply;
}

function ReplyComposer({ envelope, onReply }: Readonly<{
  envelope: InboxEnvelope;
  onReply: (reply: SignedReachReplyEvent) => void;
}>) {
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedRequest = useRef<SignedRequest | null>(null);
  const sending = useRef(false);

  async function submit() {
    if (sending.current || !message.trim()) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      if (!signedRequest.current) {
        const issuedAt = new Date().toISOString();
        const signature = await signReachReply(reachReplyEvent(envelope, message, issuedAt));
        signedRequest.current = { message, issuedAt, signature };
      }
      onReply(await sendSignedReply(envelope.reachId, signedRequest.current));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  let buttonLabel = 'Sign & send reply';
  if (signedRequest.current) buttonLabel = 'Retry signed reply';
  if (pending) buttonLabel = 'Sending signed reply…';

  return (
    <div className="mt-4 space-y-2">
      <label className="block text-xs text-gray-400" htmlFor={`reach-reply-${envelope.reachId}`}>
        Reply as yourself — signed with your own browser key
      </label>
      <textarea
        id={`reach-reply-${envelope.reachId}`}
        value={message}
        onChange={event => setMessage(event.target.value)}
        disabled={pending || signedRequest.current !== null}
        rows={3}
        className="w-full rounded border border-gray-700 bg-gray-950 p-2 text-sm disabled:opacity-50"
      />
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <button type="button" onClick={() => void submit()} disabled={pending || !message.trim()}
        className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-40">
        {buttonLabel}
      </button>
      {signedRequest.current && error && (
        <p className="text-xs text-gray-400">Retry sends the same signed reply; it cannot be edited after sending.</p>
      )}
    </div>
  );
}

function BlockSender({ envelope, onBlocked }: Readonly<{
  envelope: InboxEnvelope;
  onBlocked: (requesterDid: string) => void;
}>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = useRef(false);

  async function block() {
    if (blocking.current) return;
    blocking.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/jin/api/reach/${encodeURIComponent(envelope.reachId)}/block`, {
        method: 'POST', credentials: 'include',
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { blocked?: boolean };
      if (body.blocked !== true) throw new Error('The server did not confirm the sender block. Please try again.');
      onBlocked(envelope.requesterDid);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      blocking.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-3">
      <button type="button" onClick={() => void block()} disabled={pending}
        className="rounded border border-red-900 px-3 py-2 text-sm text-red-300 disabled:opacity-40">
        {pending ? 'Blocking sender…' : 'Block sender'}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  );
}

function ReachCard({ envelope, onBlocked }: Readonly<{
  envelope: InboxEnvelope;
  onBlocked: (requesterDid: string) => void;
}>) {
  const [reply, setReply] = useState(envelope.reply);
  const [published, setPublished] = useState(Boolean(envelope.replyPublishedAt));
  const blocked = envelope.blocked || envelope.state === 'blocked';
  const hasReply = Boolean(reply) || envelope.state === 'replied';
  const replyPending = envelope.state === 'pending';

  useEffect(() => {
    setReply(envelope.reply);
    setPublished(Boolean(envelope.replyPublishedAt));
  }, [envelope.reply, envelope.replyPublishedAt]);

  function receiveReply(signed: SignedReachReplyEvent) {
    setReply(signed);
    setPublished(true);
  }

  return (
    <article className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <h3 className="break-words text-sm font-semibold">{envelope.topic}</h3>
      <dl className="mt-2 space-y-1 break-all text-xs text-gray-400">
        <div><dt className="inline">Requester: </dt><dd className="inline font-mono">{envelope.requesterDid}</dd></div>
        <div><dt className="inline">Tier: </dt><dd className="inline">{envelope.requesterTier}</dd></div>
        <div><dt className="inline">Transcript hash: </dt><dd className="inline font-mono">{envelope.transcriptHash}</dd></div>
      </dl>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm">{envelope.message}</p>
      <div className="mt-3 rounded border border-amber-900 p-2 text-xs text-amber-200">
        <p className="font-semibold">UNVERIFIED onBehalfOf claim</p>
        <p className="whitespace-pre-wrap break-words">
          {envelope.onBehalfOf.platform}: {envelope.onBehalfOf.externalRef}
          {envelope.onBehalfOf.selfDescription && ` — ${envelope.onBehalfOf.selfDescription}`}
        </p>
      </div>
      {blocked && <p className="mt-3 text-sm text-red-300">Blocked — replies are disabled.</p>}
      {!blocked && hasReply && published && <p className="mt-3 text-xs text-green-300">Replied — signed by you</p>}
      {!blocked && reply && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{reply.payload.message}</p>}
      {!blocked && reply && !published && <PendingReply reply={reply} onPublished={() => setPublished(true)} />}
      {!blocked && replyPending && <p className="mt-3 text-sm text-gray-400">Reply pending — replies are disabled.</p>}
      {!blocked && !hasReply && !replyPending && <ReplyComposer envelope={envelope} onReply={receiveReply} />}
      {!blocked && <BlockSender envelope={envelope} onBlocked={onBlocked} />}
    </article>
  );
}

export function ReachInboxPanel() {
  const [inbox, setInbox] = useState<ReachInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [refresh, setRefresh] = useState(0);
  function markSenderBlocked(requesterDid: string) {
    setInbox(current => {
      if (!current) return current;
      return {
        ...current,
        knocks: (current.knocks ?? []).map(knock => knock.requesterDid === requesterDid
          ? { ...knock, status: 'blocked' } : knock),
        envelopes: current.envelopes.map(envelope => {
          if (envelope.requesterDid !== requesterDid) return envelope;
          return { ...envelope, blocked: true };
        }),
      };
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/jin/api/reach', { credentials: 'include', signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
          setHidden(true);
          setInbox(null);
          return;
        }
        if (!response.ok) throw new Error(await responseError(response));
        const body = await response.json() as ReachInbox;
        if (controller.signal.aborted) return;
        setHidden(Boolean(body.actAs));
        setInbox(body);
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh]);

  if (hidden || (!inbox && !error)) return null;
  const envelopes = inbox?.envelopes ?? [];
  const knocks = inbox?.knocks ?? [];

  return (
    <section aria-label="Reach inbox" className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Reach inbox</h2>
        <button type="button" className="text-xs text-gray-400" onClick={() => setRefresh(value => value + 1)}>
          Refresh reach inbox
        </button>
      </div>
      <p className="mb-3 text-xs text-gray-400">Messages and onBehalfOf claims below are untrusted text. Replies are immutable.</p>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {inbox && envelopes.length === 0 && knocks.length === 0 && <p className="text-sm text-gray-500">No reach messages yet.</p>}
      <div className="space-y-3">
        {knocks.filter(knock => knock.principalDid === inbox?.principalDid).map(knock => (
          <ReachKnockCard key={knock.requestId} knock={knock} onBlocked={markSenderBlocked} />
        ))}
        {envelopes.filter(envelope => envelope.principalDid === inbox?.principalDid).map(envelope => (
          <ReachCard key={envelope.reachId} envelope={envelope} onBlocked={markSenderBlocked} />
        ))}
      </div>
    </section>
  );
}
