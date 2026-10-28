'use client';

import { useEffect, useState } from 'react';
import OrgConnectionsPanel, { type OrgConnectionsData } from '@/app/auth/components/OrgConnectionsPanel';

/** Fixture transport only. Never creates sessions or bypasses a production route. */
export default function OrgConnectionsPreview() {
  const [ready, setReady] = useState(false);
  const [nonAdmin, setNonAdmin] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const original = window.fetch;
    const data: OrgConnectionsData = {
      connections: [{ id: 'conn_preview', memberDid: 'did:imajin:fixture-member', provider: 'external-mcp-postman', slot: 'primary', status: 'active' }],
      suspensions: [], events: [],
    };
    window.fetch = async (input, init) => {
      if (String(input) !== '/auth/api/org-connections') return original(input, init);
      if (nonAdmin) return Response.json({ error: 'Forbidden fixture' }, { status: 403 });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const memberDid = body.connectionId ? 'did:imajin:fixture-member' : '';
        const slot = memberDid ? 'primary' : '';
        const existing = data.suspensions.find(row => row.memberDid === memberDid);
        const suspendedAt = body.action === 'suspend' ? new Date().toISOString() : null;
        if (existing) existing.suspendedAt = suspendedAt;
        else data.suspensions.push({ orgDid: 'did:imajin:fixture-org', memberDid, provider: 'external-mcp-postman', slot, suspendedAt });
        data.events.unshift({ id: String(data.events.length), memberDid: memberDid || null, provider: 'external-mcp-postman',
          actorDid: 'did:imajin:fixture-admin', action: body.action, reason: body.reason, createdAt: new Date().toISOString() });
        return Response.json({ ok: true });
      }
      return Response.json(data);
    };
    setReady(true);
    return () => { window.fetch = original; };
  }, [nonAdmin]);
  if (process.env.NODE_ENV !== 'development') return null;
  return <main className="mx-auto max-w-3xl p-4 text-zinc-200">
    <h1 className="font-mono text-xl">Organization connections — development fixture</h1>
    <p className="my-3 text-sm text-zinc-400">Real members-page component; simulated metadata and transport. Not a live authorization or vault round-trip.</p>
    <label className="text-sm"><input type="checkbox" checked={nonAdmin} onChange={event => { setReady(false); setNonAdmin(event.target.checked); }} /> Non-admin fixture (403)</label>
    {ready && <OrgConnectionsPanel key={String(nonAdmin)} groupDid="did:imajin:fixture-org" />}
  </main>;
}
