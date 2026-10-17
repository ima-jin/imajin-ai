'use client';

import { useRef, useState } from 'react';
import type { ReachBearerKnock } from '@/src/lib/access/reach-bearer-wire';

export function ReachKnockCard({ knock, onBlocked }: Readonly<{
  knock: ReachBearerKnock;
  onBlocked: (requesterDid: string) => void;
}>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = useRef(false);
  const blocked = knock.status === 'blocked' || knock.status === 'revoked';

  async function block() {
    if (blocking.current) return;
    blocking.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/jin/api/reach/knocks/${encodeURIComponent(knock.requestId)}/block`, {
        method: 'POST', credentials: 'include',
      });
      const body = await response.json() as { blocked?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || `Reach request failed (${response.status}). Please try again.`);
      if (body.blocked !== true) throw new Error('The server did not confirm the sender block. Please try again.');
      onBlocked(knock.requesterDid);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to block reach sender. Please try again.');
    } finally {
      blocking.current = false;
      setPending(false);
    }
  }

  return (
    <article aria-label="Reach knock" className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <h3 className="break-words text-sm font-semibold">{knock.agentLabel}</h3>
      <dl className="mt-2 space-y-1 break-all text-xs text-gray-400">
        <div><dt className="inline">Requester: </dt><dd className="inline font-mono">{knock.requesterDid}</dd></div>
        <div><dt className="inline">Credential status: </dt><dd className="inline">{knock.status}</dd></div>
      </dl>
      <div className="mt-3 rounded border border-amber-900 p-2 text-xs text-amber-200">
        <p className="font-semibold">UNVERIFIED onBehalfOf claim</p>
        <p className="whitespace-pre-wrap break-words">
          {knock.onBehalfOf.platform}: {knock.onBehalfOf.externalRef}
          {knock.onBehalfOf.selfDescription && ` — ${knock.onBehalfOf.selfDescription}`}
        </p>
      </div>
      <p className="mt-3 text-sm text-gray-400">No action needed</p>
      {blocked ? <p className="mt-3 text-sm text-red-300">Blocked sender</p> : (
        <button type="button" onClick={() => void block()} disabled={pending}
          className="mt-3 rounded border border-red-900 px-3 py-2 text-sm text-red-300 disabled:opacity-40">
          {pending ? 'Blocking sender…' : 'Block sender'}
        </button>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    </article>
  );
}
