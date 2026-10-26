'use client';

import { useEffect, useState } from 'react';
import { isBriefStorage, type BriefStorage } from '@/src/lib/warp/brief';

export default function BriefSettingsPage() {
  const [storage, setStorage] = useState<BriefStorage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/jin/api/brief-settings', { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unavailable');
        const body = await response.json();
        if (!isBriefStorage(body.storage)) throw new Error('Unavailable');
        if (!controller.signal.aborted) setStorage(body.storage);
      }).catch(() => { if (!controller.signal.aborted) setMessage('Brief settings unavailable. Sign in as the principal owner.'); });
    return () => controller.abort();
  }, []);

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/jin/api/brief-settings', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage }),
      });
      if (!response.ok) throw new Error('Not saved');
      const body = await response.json();
      if (!body.attestationId) throw new Error('Not saved');
      setMessage(`Saved · signed event ${body.attestationId}`);
    } catch { setMessage('Brief setting was not saved. Try again.'); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto min-w-0 max-w-xl space-y-4 p-4 text-gray-200">
    <a href="/jin" className="inline-flex min-h-11 items-center text-indigo-300">Back to /jin</a>
    <h1 className="font-mono text-xl font-bold">Warp brief storage</h1>
    <p>Applies to new dispatches and follow-up prompts for your selected principal. Earlier briefs remain under their normal asset access rules.</p>
    <label className="block" htmlFor="brief-storage">Store new briefs as</label>
    <select id="brief-storage" className="min-h-11 w-full border border-gray-700 bg-gray-900 p-2"
      value={storage ?? ''} disabled={!storage || busy} onChange={event => {
        if (isBriefStorage(event.target.value)) setStorage(event.target.value);
      }}>
      {!storage && <option value="">Loading…</option>}
      <option value="full-text">Full text (default) · private signed asset</option>
      <option value="hash-only">Hash only · do not store brief text on this node</option>
    </select>
    <p className="text-sm text-gray-400">Warp still receives the prompt to execute the run. Changes are witnessed and signed by the kernel on your behalf.</p>
    <p className="text-sm text-gray-400">In hash-only mode, anyone holding a guess of a brief&apos;s text can confirm it against the plain SHA-256 hash.</p>
    <button type="button" className="min-h-11 border border-gray-700 px-4 font-mono disabled:opacity-50"
      disabled={!storage || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save brief setting'}</button>
    <output className="block break-words">{message}</output>
  </main>;
}
