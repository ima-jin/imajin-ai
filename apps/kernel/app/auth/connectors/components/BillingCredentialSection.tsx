'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';

type BillingCredential = NonNullable<ConnectorEntry['billingCredential']>;

/** Write-only credential slot. Never render server error text from a secret path. */
export function BillingCredentialSection({ credential, onReady }: Readonly<{
  credential: BillingCredential;
  onReady: (ready: boolean) => void;
}>) {
  const [status, setStatus] = useState<{ keySealed: boolean; credentialPending: boolean } | null>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(credential.route, { cache: 'no-store' });
    if (!response.ok) throw new Error('status unavailable');
    const data = await response.json();
    const next = { keySealed: data.keySealed === true, credentialPending: data.credentialPending === true };
    setStatus(next);
    onReady(next.keySealed);
  }, [credential.route, onReady]);

  useEffect(() => { void load().catch(() => setError('Could not load billing key status.')); }, [load]);

  async function mutate(method: 'POST' | 'DELETE') {
    if (busy || (method === 'POST' && !value.trim())) return;
    if (method === 'DELETE' && !window.confirm('Revoke billing key access? Inference access and sealed history are preserved.')) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(credential.route, {
        method,
        ...(method === 'POST' && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: value.trim() }),
        }),
      });
      if (!response.ok) throw new Error('operation refused');
      setEditing(false);
      await load();
    } catch {
      setError('Billing key operation failed. Check your authorization and try again.');
    } finally {
      setValue('');
      setBusy(false);
    }
  }

  const present = status?.keySealed || status?.credentialPending;
  return (
    <section aria-label="Billing (admin) key" className="space-y-3 border-t border-white/10 pt-4">
      <h3 className="text-sm font-mono text-white">Billing (admin) key</h3>
      <p className="text-xs text-gray-400">{credential.hint} Sealed through the kernel vault; never returned.</p>
      {status && (
        <output className="block text-xs text-gray-400">
          {status.keySealed ? 'Billing key sealed' : status.credentialPending ? 'Billing key awaiting owner approval' : 'billed: not connected'}
        </output>
      )}
      <p className="text-xs text-gray-400">After sealing, explicitly enable {credential.scope} in Scope grants below. Sealing alone does not grant billing access.</p>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {status && (!present || editing) && (
        <form onSubmit={(event) => { event.preventDefault(); void mutate('POST'); }} className="space-y-2">
          <input type="password" aria-label="Billing (admin) key" autoComplete="off" spellCheck={false}
            value={value} onChange={(event) => setValue(event.target.value)} required disabled={busy}
            className="w-full bg-white/5 border border-white/10 px-3 py-2 text-sm text-white font-mono" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !value.trim()}
              className="px-4 py-2 bg-amber-500 text-black text-sm disabled:opacity-50">
              {busy ? 'Sealing…' : 'Seal billing key'}
            </button>
            {editing && <button type="button" disabled={busy} onClick={() => { setEditing(false); setValue(''); setError(null); }}
              className="px-4 py-2 text-sm text-gray-400">Cancel</button>}
          </div>
        </form>
      )}
      {present && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { setEditing(true); setValue(''); }}
            className="px-4 py-2 text-sm text-gray-300 disabled:opacity-50">Rotate billing key</button>
          <button type="button" disabled={busy} onClick={() => { void mutate('DELETE'); }}
            className="px-4 py-2 text-sm text-red-400 disabled:opacity-50">Revoke billing key</button>
        </div>
      )}
    </section>
  );
}
