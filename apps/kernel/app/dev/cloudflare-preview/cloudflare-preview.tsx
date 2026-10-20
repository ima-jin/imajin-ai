'use client';

import { useEffect, useState } from 'react';
import { CloudflarePanel } from '../../jin/cloudflare-panel';
import { VaultImportPanel } from '../../jin/vault-import-panel';
import { approvalCardAnchorId } from '../../jin/approval-anchor';
import { JsonView } from '../../jin/cloudflare-editors';
import { CloudflareApprovalDetail } from '../../jin/cloudflare-approval-detail';
import { fixtureZoneId, installCloudflarePreview, type FixtureProposal } from './transport';

export function CloudflarePreview() {
  const [ready, setReady] = useState(false);
  const [proposals, setProposals] = useState<FixtureProposal[]>([]);
  useEffect(() => {
    const dispose = installCloudflarePreview((proposal) => setProposals((current) => [...current, proposal]));
    setReady(true);
    return dispose;
  }, []);
  return <main className="cloudflare-surface mx-auto min-w-0 max-w-5xl p-4">
    <h1 className="font-mono text-xl">Cloudflare · development fixture</h1>
    <p className="my-3 text-sm">Real import and operations panels, entirely mocked transport. Use fake credential text only.
      No live Cloudflare, vault writes, signatures or approved execution. Authentication on real API routes is unchanged.</p>
    <p className="break-all font-mono text-sm">Domain: example.com · Zone ID: {fixtureZoneId}</p>
    <p className="text-sm">Select the fixture group owner and Cloudflare import mode. Use any fake DID as grantee.
      Preview proxy/cache changes, request approval, check hostname validation records and inspect signed-history shape.</p>
    {ready && <><VaultImportPanel /><CloudflarePanel /></>}
    <section className="mt-6 space-y-3">
      <h2 className="font-mono">Fixture pending proposals · no execution</h2>
      {proposals.map((proposal) => <article key={proposal.proposalId} id={approvalCardAnchorId(proposal.proposalId)}
        className="min-w-0 border border-white/15 p-3">
        <h3 className="font-mono">{proposal.kind}</h3>
        {proposal.kind.startsWith('cloudflare:') ? <CloudflareApprovalDetail detail={proposal.detail as Record<string, unknown>} /> : <JsonView value={proposal.detail} />}
        <p className="text-xs">Production approval requires the real human&apos;s countersignature; this fixture never applies a proposal.</p>
      </article>)}
    </section>
  </main>;
}
