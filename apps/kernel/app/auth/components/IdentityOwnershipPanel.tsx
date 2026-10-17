'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { fireAndForget } from '@/src/lib/async/fire-and-forget';
import { setActingAs } from '@imajin/ui/server';

interface PendingTransfer {
  id: string;
  from: string;
  to: string;
  by: string;
  policy: string;
  createdAt: string;
}

export interface OwnershipState {
  groupDid: string;
  groupName: string | null;
  ownerDid: string;
  policy: string;
  pendingTransfer: PendingTransfer | null;
  viewerDid: string;
  viewerRole: string | null;
  canTransfer: boolean;
  canAccept: boolean;
}

const primary = 'px-4 py-2 font-mono text-sm bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50';
const secondary = 'px-4 py-2 font-mono text-sm border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-50';

async function readResponse(response: Response): Promise<OwnershipState> {
  const body = await response.json();
  if (!response.ok) {
    if (body.code === 'AGENT_APPROVAL_REQUIRED') {
      throw new Error('Owner approval required. The owner must perform this action from their own session.');
    }
    throw new Error(body.error || 'Unable to update ownership.');
  }
  return body;
}

export default function IdentityOwnershipPanel({ groupDid }: Readonly<{ groupDid: string }>) {
  const router = useRouter();
  const [state, setState] = useState<OwnershipState | null>(null);
  const [newOwnerDid, setNewOwnerDid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const endpoint = `/auth/api/groups/${encodeURIComponent(groupDid)}/transfer-owner`;
  const acceptancePath = `/auth/groups/${encodeURIComponent(groupDid)}/ownership`;

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
    setState(await readResponse(response));
  }, [endpoint]);

  useEffect(() => {
    setState(null);
    setError(null);
    fireAndForget(load().catch((err: Error) => setError(err.message)), 'ownership:load');
  }, [load]);

  async function mutate(method: string, suffix: string, body: Record<string, string>, success: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await readResponse(await fetch(`${endpoint}${suffix}`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      setMessage(success);
      setNewOwnerDid('');
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await readResponse(await fetch(
        `/auth/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(state!.viewerDid)}`,
        { method: 'DELETE', credentials: 'include' },
      ));
      setActingAs(null);
      globalThis.location.assign('/auth');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to leave identity.');
    } finally {
      setBusy(false);
    }
  }

  const pending = state?.pendingTransfer;
  return (
    <section aria-labelledby="ownership-heading" className="border border-zinc-800 bg-zinc-900 p-6 space-y-4">
      <h2 id="ownership-heading" className="font-mono text-lg font-semibold text-white">Ownership</h2>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {message && <p role="status" className="text-sm text-green-400">{message}</p>}
      {!state && !error && <p className="text-sm text-zinc-400">Loading ownership…</p>}
      {state && (
        <>
          {state.groupName && <p className="text-sm text-zinc-300">{state.groupName}</p>}
          <dl className="text-sm space-y-2">
            <div><dt className="text-zinc-500">Current owner</dt><dd className="font-mono text-zinc-200 break-all">{state.ownerDid}</dd></div>
            <div><dt className="text-zinc-500">Node policy</dt><dd className="font-mono text-zinc-300">{state.policy}</dd></div>
          </dl>
          <p className="text-sm text-zinc-400">
            The identity and its keys stay the same. Ownership changes only after the named person accepts.
            The previous owner stays as an admin and may leave.
          </p>
          {pending && (
            <div className="border border-amber-700/50 p-4 space-y-3">
              <p className="text-sm text-amber-400">Pending acceptance</p>
              <p className="font-mono text-sm text-zinc-200 break-all">{pending.to}</p>
              <p className="text-sm text-zinc-400">Share this invitation with the named person. Only their own signed-in session can accept.</p>
              <Link href={acceptancePath} className="block text-sm text-amber-400 underline break-all">
                {acceptancePath}
              </Link>
              <div className="flex flex-wrap gap-3">
                {state.canAccept && (
                  <button type="button" disabled={busy} className={primary}
                    onClick={() => fireAndForget(mutate('POST', '/accept', { transferId: pending.id }, 'Ownership accepted. You are now the owner.'), 'ownership:accept')}>
                    Accept ownership
                  </button>
                )}
                {state.canTransfer && (
                  <button type="button" disabled={busy} className={secondary}
                    onClick={() => fireAndForget(mutate('DELETE', '', { transferId: pending.id }, 'Ownership transfer cancelled.'), 'ownership:cancel')}>
                    Cancel transfer
                  </button>
                )}
              </div>
            </div>
          )}
          {state.canTransfer && !pending && (
            <form className="space-y-3" onSubmit={(event) => {
              event.preventDefault();
              fireAndForget(mutate('POST', '', { newOwnerDid: newOwnerDid.trim() }, 'Transfer proposed. Share the invitation with the new owner.'), 'ownership:transfer');
            }}>
              <label htmlFor="new-owner-did" className="block text-sm text-zinc-300">New owner DID</label>
              <input id="new-owner-did" required value={newOwnerDid} onChange={(event) => setNewOwnerDid(event.target.value)}
                placeholder="did:imajin:…" className="w-full border border-zinc-700 bg-black p-3 font-mono text-sm text-white" />
              <p className="text-xs text-zinc-500">Choose a person. If they are not a member yet, accepting this invitation also joins them to the identity.</p>
              <button type="submit" disabled={busy || !newOwnerDid.trim()} className={primary}>Transfer ownership</button>
            </form>
          )}
          {!state.canTransfer && !pending && <p className="text-sm text-zinc-400">Only the current owner can initiate a transfer.</p>}
          {state.viewerRole === 'admin' && (
            <button type="button" disabled={busy} className={secondary} onClick={() => fireAndForget(leave(), 'ownership:leave')}>Leave identity</button>
          )}
        </>
      )}
    </section>
  );
}
