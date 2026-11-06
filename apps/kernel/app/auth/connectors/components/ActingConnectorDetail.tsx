'use client';

import { useEffect, useState } from 'react';
import { getActingAs } from '@imajin/ui/server';
import type { ConnectorEntry } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from './ConnectorDetail';
import OrgConnectorSection from './OrgConnectorSection';

/** Resolve mode before mounting any credential section; never read session DID/handle. */
export function ActingConnectorDetail({ entry }: Readonly<{ entry: ConnectorEntry }>) {
  const [context, setContext] = useState<{ orgDid: string | null; human: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const sync = async () => {
      const current = ++revision;
      setContext(null);
      const orgDid = getActingAs();
      if (!orgDid) { setContext({ orgDid: null, human: false }); return; }
      try {
        const response = await fetch('/auth/api/session', { cache: 'no-store' });
        const session = response.ok ? await response.json() : null;
        if (!cancelled && current === revision) setContext({
          orgDid, human: session?.scope === 'actor' && session?.subtype !== 'agent',
        });
      } catch {
        if (!cancelled && current === revision) setContext({ orgDid, human: false });
      }
    };
    void sync();
    globalThis.addEventListener('imajin:acting-as-changed', sync);
    return () => { cancelled = true; globalThis.removeEventListener('imajin:acting-as-changed', sync); };
  }, []);
  if (!context) return <p className="text-gray-400">Loading connector context…</p>;
  const serviceKey = !entry.backendPending && ['static-secret', 'token-paste'].includes(entry.ingestionPattern);
  if (context.orgDid && serviceKey) return <OrgConnectorSection key={context.orgDid}
    orgDid={context.orgDid} humanSession={context.human} connectorId={entry.id} />;
  return <ConnectorDetail key={context.orgDid ?? 'personal'} entry={entry} />;
}
