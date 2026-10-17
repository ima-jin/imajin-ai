'use client';

import { useEffect, useState } from 'react';
import type { DomainBinding } from '@/src/lib/domains/service';
import { fireAndForget } from '@/src/lib/async/fire-and-forget';

const inputClass = 'w-full border border-zinc-700 bg-transparent px-3 py-2 font-mono text-sm focus:border-violet-500';
const buttonClass = 'border border-zinc-700 px-3 py-2 font-mono text-sm hover:border-violet-500 disabled:opacity-40';

async function domainRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (response.status === 204) return {};
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Domain operation failed');
  return data;
}
function DomainControls({ binding, did, busy, removing, setRemoving, mutate }: Readonly<{
  binding: DomainBinding;
  did: string;
  busy: boolean;
  removing: string | null;
  setRemoving: (domain: string | null) => void;
  mutate: (path: string, method: string) => Promise<void>;
}>) {
  if (binding.zoneOwner !== did) return <p className="text-xs text-zinc-500">Read-only: managed by the DNS zone owner.</p>;
  if (binding.status === 'revoked') return <p className="text-xs text-zinc-500">Re-add this domain above before verifying again.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {binding.method === 'dns-txt' && (
        <button type="button" disabled={busy} className={buttonClass}
          onClick={() => fireAndForget(mutate(`/${encodeURIComponent(binding.domain)}/verify`, 'POST'), 'domains:verify')}>Verify DNS</button>
      )}
      {removing === binding.domain ? (
        <>
          <span className="text-sm self-center">Revoke and remove this domain?</span>
          <button type="button" disabled={busy} className={`${buttonClass} text-red-400`}
            onClick={() => fireAndForget(mutate(`/${encodeURIComponent(binding.domain)}`, 'DELETE'), 'domains:remove')}>Confirm remove</button>
          <button type="button" disabled={busy} className={buttonClass} onClick={() => setRemoving(null)}>Cancel</button>
        </>
      ) : (
        <button type="button" disabled={busy} className={buttonClass} onClick={() => setRemoving(binding.domain)}>Remove</button>
      )}
    </div>
  );
}

export default function DomainsSection({ did }: Readonly<{ did: string }>) {
  const endpoint = `/auth/api/identities/${encodeURIComponent(did)}/domains`;
  const [domains, setDomains] = useState<DomainBinding[]>([]);
  const [domain, setDomain] = useState('');
  const [appDid, setAppDid] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDomains([]);
    setError(null);
    setRemoving(null);
    fireAndForget(domainRequest(endpoint, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setDomains(data.domains);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load domains');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    }), 'domains:load');
    return () => controller.abort();
  }, [endpoint]);

  async function mutate(path: string, method: string, body?: object) {
    setBusy(true);
    setError(null);
    try {
      await domainRequest(`${endpoint}${path}`, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const data = await domainRequest(endpoint);
      setDomains(data.domains);
      setRemoving(null);
      if (body) {
        setDomain('');
        setAppDid('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Domain operation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="domains-heading" className="border border-zinc-800 bg-surface-card p-4 space-y-4 text-zinc-200">
      <h2 id="domains-heading" className="font-mono text-lg">Domains</h2>
      <p className="text-sm text-zinc-400">
        Prove DNS zone ownership with a public TXT record. Site ownership is separate and comes from the registered app owner.
        Keep the record in place: periodic checks revoke verification when proof disappears.
      </p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        fireAndForget(mutate('', 'POST', { domain, appDid: appDid.trim() || null }), 'domains:add');
      }}>
        <div>
          <label htmlFor="domain-name" className="block font-mono text-sm mb-1">Domain</label>
          <input id="domain-name" value={domain} onChange={(event) => setDomain(event.target.value)}
            required maxLength={253} placeholder="example.com" disabled={busy || loading} className={inputClass} />
        </div>
        <div>
          <label htmlFor="domain-app" className="block font-mono text-sm mb-1">Registered app DID (optional)</label>
          <input id="domain-app" value={appDid} onChange={(event) => setAppDid(event.target.value)}
            maxLength={256} placeholder="did:imajin:…" disabled={busy || loading} className={inputClass} />
          <p className="mt-1 text-xs text-zinc-500">Site owner is resolved from the active app registry; DNS control belongs to this identity. No app means the zone owner is also the site owner.</p>
        </div>
        <button type="submit" disabled={busy || loading || !domain.trim()} className={buttonClass}>Add domain</button>
      </form>
      {loading && <p role="status" className="text-sm text-zinc-400">Loading domains…</p>}
      {!loading && !error && domains.length === 0 && <p className="text-sm text-zinc-500">No domains added.</p>}
      <ul className="space-y-3">
        {domains.map((binding) => (
          <li key={`${binding.domain}:${binding.zoneOwner}`} className="border border-zinc-800 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono break-all">{binding.domain}</span>
              <span className={binding.status === 'verified' ? 'text-green-400 text-sm' : 'text-zinc-400 text-sm'}>{binding.status}</span>
            </div>
            <p className="text-xs break-all text-zinc-400">Zone owner: {binding.zoneOwner}</p>
            <p className="text-xs break-all text-zinc-400">Site owner: {binding.siteOwner}</p>
            {binding.method === 'dns-txt' && (
              <div className="text-sm space-y-1">
                <p>Add this TXT record at your DNS provider, wait for propagation, then verify:</p>
                <p className="font-mono break-all">Name: _imajin.{binding.domain}</p>
                <p className="font-mono break-all">Value: {binding.zoneOwner}</p>
              </div>
            )}
            {binding.method === 'imajin-issued' && <p className="text-sm text-zinc-400">Issued by the Imajin organization.</p>}
            {binding.status === 'legacy' && <p className="text-sm text-zinc-400">Routing only — not verified ownership.</p>}
            {binding.checkedAt && <p className="text-xs text-zinc-500">Last checked: {new Date(binding.checkedAt).toLocaleString()}</p>}
            {binding.status === 'verified' && binding.attestation && (
              <a href={`${endpoint}/public?domain=${encodeURIComponent(binding.domain)}`}
                target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-violet-400 underline">Signed evidence</a>
            )}
            <DomainControls binding={binding} did={did} busy={busy} removing={removing}
              setRemoving={setRemoving} mutate={mutate} />
          </li>
        ))}
      </ul>
    </section>
  );
}
