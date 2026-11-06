'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';
import { ProviderSectionNotice, sectionHeaders, useProviderSection } from './ConnectorMode';

type BillingCredential = NonNullable<ConnectorEntry['billingCredential']>;
function billingKeyLabel(status: { keySealed: boolean; credentialPending: boolean }, orgHeld: boolean): string {
  if (orgHeld) return status.keySealed ? 'Billing key loaded' : 'Not loaded — re-load here';
  if (status.keySealed) return 'Billing key sealed';
  if (status.credentialPending) return 'Billing key awaiting owner approval';
  return 'billed: not connected';
}

/** Write-only credential slot. Never render server error text from a secret path. */
export function BillingCredentialSection({ credential, onReady, provider = 'anthropic' }: Readonly<{
  credential: BillingCredential;
  onReady: (ready: boolean) => void;
  provider?: string;
}>) {
  const { route, disabled, note, orgDid, followUp } = useProviderSection(provider, 'billing-key', credential.route);
  const [status, setStatus] = useState<{
    keySealed: boolean; credentialPending: boolean; loadedByDid?: string; loadedAt?: string;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (disabled) return;
    const response = await fetch(route, { headers: sectionHeaders(orgDid), cache: 'no-store' });
    if (!response.ok) throw new Error('status unavailable');
    const data = await response.json();
    const next = {
      keySealed: data.keySealed === true && (!orgDid || !!(data.loadedByDid && data.loadedAt)),
      credentialPending: data.credentialPending === true,
      loadedByDid: typeof data.loadedByDid === 'string' ? data.loadedByDid : undefined,
      loadedAt: typeof data.loadedAt === 'string' ? data.loadedAt : undefined,
    };
    setStatus(next);
    onReady(next.keySealed);
  }, [route, onReady, disabled, orgDid]);

  useEffect(() => { void load().catch(() => setError('Could not load billing key status.')); }, [load]);

  async function mutate(method: 'POST' | 'DELETE') {
    const submitted = orgDid ? input.current?.value.trim() ?? '' : value.trim();
    if (disabled || busy || (method === 'POST' && !submitted)) return;
    if (method === 'DELETE' && !window.confirm('Revoke billing key access? Inference access and sealed history are preserved.')) return;
    setBusy(true);
    setError(null);
    try {
      const request = fetch(route, {
        method,
        headers: sectionHeaders(orgDid),
        ...(method === 'POST' && {
          body: JSON.stringify({ token: submitted }),
        }),
      });
      if (input.current) input.current.value = '';
      setValue('');
      const response = await request;
      if (!response.ok) throw new Error('operation refused');
      setEditing(false);
      await load();
    } catch {
      setError('Billing key operation failed. Check your authorization and try again.');
    } finally {
      if (input.current) input.current.value = '';
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
          {billingKeyLabel(status, !!orgDid)}
          {orgDid && status.keySealed && <span className="block">Loaded by {status.loadedByDid} · {status.loadedAt}</span>}
        </output>
      )}
      <ProviderSectionNotice note={note} followUp={followUp} />
      <p className="text-xs text-gray-400">After sealing, explicitly enable {credential.scope} in Scope grants below. Sealing alone does not grant billing access.</p>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {!disabled && status && (!present || editing) && (
        <form onSubmit={(event) => { event.preventDefault(); void mutate('POST'); }} className="space-y-2">
          <input ref={input} type="password" aria-label="Billing (admin) key" autoComplete={orgDid ? 'new-password' : 'off'} spellCheck={false}
            value={orgDid ? undefined : value} onChange={orgDid ? undefined : (event) => setValue(event.target.value)} required disabled={busy}
            className="w-full bg-white/5 border border-white/10 px-3 py-2 text-sm text-white font-mono" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || (!orgDid && !value.trim())}
              className="px-4 py-2 bg-amber-500 text-black text-sm disabled:opacity-50">
              {busy ? 'Sealing…' : 'Seal billing key'}
            </button>
            {editing && <button type="button" disabled={busy} onClick={() => { setEditing(false); setValue(''); setError(null); }}
              className="px-4 py-2 text-sm text-gray-400">Cancel</button>}
          </div>
        </form>
      )}
      {!disabled && present && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { setEditing(true); setValue(''); }}
            className="px-4 py-2 text-sm text-gray-300 disabled:opacity-50">Rotate billing key</button>
          {status?.keySealed && (
            <button type="button" disabled={busy} onClick={() => { void mutate('DELETE'); }}
              className="px-4 py-2 text-sm text-red-400 disabled:opacity-50">Revoke billing key</button>
          )}
        </div>
      )}
      {status?.credentialPending && (
        <p className="text-xs text-gray-400">No usable grant exists yet. Withdraw the billing scope below to keep ingestion off while approval is pending.</p>
      )}
    </section>
  );
}
