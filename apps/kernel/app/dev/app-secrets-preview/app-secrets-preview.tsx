'use client';

import { useEffect, useState } from 'react';
import { AppSecretsPanel } from '../../jin/app-secrets-panel';
import { ProvisionedAppsList } from '../../jin/provisioned-apps-list';

const OPERATOR = `did:imajin:fixture-operator-${'a1b2c3d4'.repeat(8)}`;
const APP = `did:imajin:fixture-app-${'1234abcd'.repeat(8)}`;
const UNKNOWN_LINE = { at: null, by: null };
const provenance = {
  created: { at: '2026-10-13T08:00:00Z', by: OPERATOR },
  provisioned: { at: '2026-10-13T08:05:00Z', proposedBy: 'did:imajin:fixture-agent', approvedBy: OPERATOR },
  claimed: { at: '2026-10-13T08:10:00Z', by: `fixture-host-${'long-hostname-'.repeat(6)}.example.invalid` },
  lastSeen: { at: '2026-10-20T18:00:00Z', by: APP },
};
const awaiting = { slug: 'fixture-awaiting', appDid: null, repoUrl: null, claimed: false };
const apps = [
  {
    appDid: APP, slug: 'fixture-claimed', name: 'Claimed fixture app', claimed: true, active: true,
    claimExpiresAt: null, provenance,
    secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B', status: 'active', timeline: [
      { phase: 'fetched', at: '2026-10-20T18:00:00Z', operatorDid: OPERATOR },
    ] }],
  },
  {
    ...awaiting, name: 'Awaiting claim fixture app', active: false, secrets: [],
    claimExpiresAt: '2020-01-02T03:04:05Z',
    provenance: { ...provenance, claimed: UNKNOWN_LINE, lastSeen: UNKNOWN_LINE },
  },
  {
    appDid: 'did:imajin:fixture-legacy', slug: 'fixture-legacy', name: 'Legacy metadata fixture app',
    claimed: true, active: true, claimExpiresAt: null, secrets: [],
    provenance: {
      created: UNKNOWN_LINE, provisioned: { at: null, proposedBy: null, approvedBy: null },
      claimed: UNKNOWN_LINE, lastSeen: UNKNOWN_LINE,
    },
  },
];

export default function AppSecretsPreview() {
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, window.location.origin).pathname === '/jin/api/app-secrets') {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method !== 'GET') return Response.json({ error: 'Fixture only — no proposals are sent.' }, { status: 403 });
        return Response.json({ apps });
      }
      return originalFetch(input, init);
    };
    setReady(true);
    return () => { globalThis.fetch = originalFetch; };
  }, []);

  return (
    <main className="mx-auto min-w-0 max-w-4xl p-4 text-gray-200 [overflow-wrap:anywhere]">
      <header className="border border-amber-700 p-3 space-y-2">
        <h1 className="font-mono text-xl">App secrets fixture preview</h1>
        <p className="text-sm text-amber-300">Development fixture only — not live data. No secret values, claim codes, or real mutations.</p>
        <p className="text-xs text-gray-400">Real panel with claimed, awaiting claim (expired), and legacy-unknown metadata. Inspect at desktop and 390px width.</p>
      </header>
      {ready && <AppSecretsPanel />}
      <section className="mt-6">
        <h2 className="font-mono text-sm">Provision app · fixture reissue destination</h2>
        <ProvisionedAppsList apps={[awaiting]} reissueBusy={false}
          onReissue={() => setNotice('Fixture only — reissue reached the existing provision control. No proposal was sent.')} />
        {notice && <output className="block mt-2 text-xs text-amber-300">{notice}</output>}
      </section>
    </main>
  );
}
