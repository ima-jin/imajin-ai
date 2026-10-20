'use client';

import { useState } from 'react';
import { CLOUDFLARE_CAPABILITIES, type CloudflareImport } from '@/src/lib/cloudflare/contract';

interface ZoneGrant {
  grantId: string; agentDid: string; capabilities: string[]; expiry: string; revokedAt: string | null;
}

const control = 'min-h-11 border border-gray-700 bg-gray-950 p-2 text-sm text-gray-100 disabled:opacity-40';

/** Reuses existing grant issue/renew/revoke primitives; this component never handles a credential. */
export function CloudflareDelegations({ ownerDid, zone }: Readonly<{ ownerDid: string; zone: CloudflareImport }>) {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<ZoneGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const query = new URLSearchParams({ ownerDid, domain: zone.domain, zoneId: zone.zoneId });

  const load = async () => {
    const response = await fetch(`/jin/api/cloudflare-grants?${query}`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const result = await response.json() as { grants: ZoneGrant[] };
    if (!Array.isArray(result.grants)) throw new Error('Unavailable');
    setGrants(result.grants);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setNotice('');
    try { await operation(); }
    catch { setNotice('Zone grants unavailable. Check current owner authority and retry.'); }
    finally { setBusy(false); }
  };
  const mutate = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error('Unavailable');
    await load();
    setNotice('Zone authority updated. Revocation takes effect on the next operation.');
  };

  return <section className="space-y-2 border-t border-gray-800 pt-2" aria-label={`Grants for ${zone.domain}`}>
    <button type="button" className={control} disabled={busy} onClick={() => void run(async () => {
      if (!open) await load();
      setOpen(!open);
    })}>{open ? 'Hide zone grants' : 'Manage zone grants'}</button>
    {notice && <output className="block text-xs text-amber-300" aria-live="polite">{notice}</output>}
    {open && <>
      <p className="break-all text-xs">Owner: {ownerDid} · Zone: {zone.domain} · {zone.zoneId}</p>
      <p className="text-xs">Delegate operations to any DID without pasting the token again. Leases default to 24 hours and can be renewed.</p>
      <form className="space-y-2" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void run(() => mutate('/jin/api/cloudflare-grants', 'POST', {
          ownerDid, domain: zone.domain, zoneId: zone.zoneId, granteeDid: data.get('granteeDid'),
          capabilities: data.getAll('capabilities'), ttlMs: Number(data.get('ttlMs')),
        }));
      }}>
        <label className="block text-xs">New zone grantee DID
          <input name="granteeDid" aria-label="New zone grantee DID" required disabled={busy} className={`${control} block w-full`}
            autoCapitalize="none" spellCheck={false} />
        </label>
        <fieldset disabled={busy} className="flex flex-wrap gap-2"><legend className="text-xs">New grant capabilities</legend>
          {CLOUDFLARE_CAPABILITIES.map(capability => <label key={capability} className="flex min-h-11 items-center gap-1 text-xs">
            <input type="checkbox" name="capabilities" value={capability} defaultChecked={capability === 'cloudflare:read'} />{capability}
          </label>)}
        </fieldset>
        <label className="block text-xs">New grant lease
          <select name="ttlMs" disabled={busy} className={`${control} block w-full`}>
            <option value={86400_000}>24 hours</option><option value={7 * 86400_000}>7 days</option>
            <option value={30 * 86400_000}>30 days</option>
          </select>
        </label>
        <button type="submit" className={control} disabled={busy}>Delegate zone operations</button>
      </form>
      {grants.map(grant => <article key={grant.grantId} className="space-y-1 border border-gray-800 p-2 text-xs">
        <p className="break-all">{grant.agentDid} · {grant.revokedAt ? 'revoked' : 'lease'} · {grant.expiry}</p>
        <p className="break-words">{grant.capabilities.join(', ')}</p>
        {!grant.revokedAt && <div className="flex flex-wrap gap-2">
          <button type="button" className={control} disabled={busy} onClick={() => void run(() =>
            mutate(`/auth/api/grants/${encodeURIComponent(grant.grantId)}/renew`, 'POST', { ttlMs: 86400_000 }))}>Renew for 24 hours</button>
          <button type="button" className={control} disabled={busy} onClick={() => void run(() =>
            mutate(`/auth/api/grants/${encodeURIComponent(grant.grantId)}`, 'DELETE'))}>Revoke zone grant</button>
        </div>}
      </article>)}
    </>}
  </section>;
}
