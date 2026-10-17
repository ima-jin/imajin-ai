'use client';

import { useEffect, useState } from 'react';
import type { DomainBinding } from '@/src/lib/domains/service';
import { fireAndForget } from '@/src/lib/async/fire-and-forget';

export function VerifiedDomains({ did }: Readonly<{ did: string }>) {
  const [domains, setDomains] = useState<DomainBinding[]>([]);
  const endpoint = `/auth/api/identities/${encodeURIComponent(did)}/domains/public`;

  useEffect(() => {
    const controller = new AbortController();
    setDomains([]);
    fireAndForget(fetch(endpoint, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Unable to load domain evidence');
      const data: { domains: DomainBinding[] } = await response.json();
      if (!controller.signal.aborted) {
        setDomains(data.domains.filter((binding) => binding.status === 'verified' && binding.attestation));
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('Unable to load public domain evidence', error);
    }), 'profile:domains');
    return () => controller.abort();
  }, [endpoint]);

  if (domains.length === 0) return null;
  return (
    <section aria-label="Verified domains" className="mb-4 border border-zinc-800 p-3 text-left">
      <h2 className="font-mono text-xs uppercase text-zinc-400 mb-2">Verified domains</h2>
      <ul className="space-y-2">
        {domains.map((binding) => (
          <li key={`${binding.domain}:${binding.zoneOwner}`} className="flex flex-wrap justify-between gap-2 text-sm">
            <a href={`https://${binding.domain}`} target="_blank" rel="noopener noreferrer"
              className="font-mono break-all text-violet-400 underline">{binding.domain}</a>
            <a href={`${endpoint}?domain=${encodeURIComponent(binding.domain)}`} target="_blank" rel="noopener noreferrer"
              className="text-zinc-400 underline">Signed evidence</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
