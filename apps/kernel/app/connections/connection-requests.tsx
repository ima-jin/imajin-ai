'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

interface DirectRequest {
  code: string;
  fromDid: string;
  fromHandle: string | null;
  fromName?: string | null;
  toDid: string;
  toHandle?: string | null;
  toName?: string | null;
  delivery: string;
  status: string;
}

interface RequestList {
  invites: DirectRequest[];
  effectiveDid?: string;
  effectiveName?: string | null;
}

const REQUESTS_URL = '/connections/api/invites';
const BUTTON_STYLE = 'min-h-11 px-3 py-2 border border-white/20 text-sm font-mono hover:bg-white/10 disabled:opacity-40';
const ACTION_MESSAGES = {
  accept: 'Connection accepted.',
  decline: 'Connection request declined.',
  cancel: 'Connection request cancelled.',
};

function counterparty(request: DirectRequest, incoming: boolean): string {
  if (incoming) return request.fromName || request.fromHandle || request.fromDid;
  return request.toName || request.toHandle || request.toDid;
}

async function requestAction(url: string, method: string, body?: Record<string, string>) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Connection request failed. Please try again.');
}

function PendingRequests({
  requests, incoming, busy, onAction,
}: Readonly<{
  requests: DirectRequest[];
  incoming: boolean;
  busy: boolean;
  onAction: (request: DirectRequest, action: 'accept' | 'decline' | 'cancel') => void;
}>) {
  if (requests.length === 0) return null;
  return (
    <section aria-label={incoming ? 'Incoming connection requests' : 'Sent connection requests'} className="space-y-3">
      <h3 className="text-sm font-mono text-gray-300">{incoming ? 'Incoming requests' : 'Sent requests · awaiting acceptance'}</h3>
      {requests.map((request) => (
        <div key={request.code} className="flex flex-wrap items-center gap-3 border border-white/10 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white break-words">{counterparty(request, incoming)}</p>
            <p className="text-xs text-gray-500 break-all">{incoming ? request.fromDid : request.toDid}</p>
          </div>
          {incoming ? (
            <div className="flex gap-2">
              <button type="button" className={BUTTON_STYLE} disabled={busy} onClick={() => onAction(request, 'accept')}>Accept</button>
              <button type="button" className={BUTTON_STYLE} disabled={busy} onClick={() => onAction(request, 'decline')}>Decline</button>
            </div>
          ) : (
            <button type="button" className={BUTTON_STYLE} disabled={busy} onClick={() => onAction(request, 'cancel')}>Cancel request</button>
          )}
        </div>
      ))}
    </section>
  );
}

export default function ConnectionRequests({ onConnected }: Readonly<{ onConnected: () => void }>) {
  const { data: sent, error: sentError, mutate: refreshSent } = useSWR<RequestList>(REQUESTS_URL);
  const { data: received, error: receivedError, mutate: refreshReceived } = useSWR<RequestList>(`${REQUESTS_URL}?direction=incoming`);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (new URLSearchParams(globalThis.location.search).get('connect') === '1') input.current?.focus();
  }, []);

  async function refresh() {
    await Promise.all([refreshSent(), refreshReceived()]);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const value = target.trim();
    if (!value || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await requestAction(REQUESTS_URL, 'POST', value.startsWith('did:') ? { toDid: value } : { handle: value });
      setTarget('');
      setStatus({ error: false, message: 'Connection request sent. They must accept before you can select them for an invoice.' });
      await refresh();
    } catch (error) {
      setStatus({ error: true, message: error instanceof Error ? error.message : 'Unable to send request.' });
    } finally {
      setBusy(false);
    }
  }

  async function act(request: DirectRequest, action: 'accept' | 'decline' | 'cancel') {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const url = `${REQUESTS_URL}/${encodeURIComponent(request.code)}`;
    try {
      if (action === 'accept') await requestAction(`${url}/accept`, 'POST');
      else if (action === 'decline') await requestAction(url, 'PATCH', { action: 'decline' });
      else await requestAction(url, 'DELETE');
      setStatus({ error: false, message: ACTION_MESSAGES[action] });
      await refresh();
      if (action === 'accept') onConnected();
    } catch (error) {
      setStatus({ error: true, message: error instanceof Error ? error.message : 'Unable to update request.' });
    } finally {
      setBusy(false);
    }
  }

  const pending = (items: DirectRequest[] = []) => items.filter((item) => item.delivery === 'direct' && item.status === 'pending');

  return (
    <section id="connect" aria-labelledby="connect-heading" className="space-y-4 mb-8 border border-white/10 bg-white/5 p-4">
      <h2 id="connect-heading" className="text-lg font-mono font-semibold">Connect</h2>
      {sent?.effectiveDid && (
        <p className="text-sm text-amber-300 break-all">
          Requesting connections as {sent.effectiveName || sent.effectiveDid}
          {sent.effectiveName ? ` · ${sent.effectiveDid}` : ''}
        </p>
      )}
      <p className="text-sm text-gray-400">Already on Imajin? Send a request by handle or DID. A connection gives no membership or access to your organization&apos;s roster.</p>
      <form onSubmit={send} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="connection-target">Handle or DID</label>
        <input
          ref={input}
          id="connection-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="@handle or did:…"
          disabled={busy}
          className="min-w-0 w-full sm:w-auto sm:flex-1 bg-gray-900 border border-white/20 px-3 py-2 text-sm text-white"
        />
        <button type="submit" disabled={busy || !target.trim()} className={`${BUTTON_STYLE} w-full sm:w-auto`}>Send connection request</button>
      </form>
      {status && <p role={status.error ? 'alert' : 'status'} className={status.error ? 'text-sm text-red-400' : 'text-sm text-green-400'}>{status.message}</p>}
      {(sentError || receivedError) && <p role="alert" className="text-sm text-red-400">Could not load connection requests. Refresh to try again.</p>}
      <PendingRequests requests={pending(received?.invites)} incoming busy={busy} onAction={(request, action) => { void act(request, action); }} />
      <PendingRequests requests={pending(sent?.invites)} incoming={false} busy={busy} onAction={(request, action) => { void act(request, action); }} />
    </section>
  );
}
