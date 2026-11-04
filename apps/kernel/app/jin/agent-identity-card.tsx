'use client';
import Link from 'next/link';

import type { SelfDiscoveryCard, SelfDiscoveryConnector } from '@/src/lib/inference/self-discovery-card';

export type OperatorIdentityCard = SelfDiscoveryCard & { name: string | null };
export type AgentCards = { principalDid: string; cards: OperatorIdentityCard[] };

function Detail({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div><dt className="inline text-gray-400">{label}: </dt><dd className="inline">{value}</dd></div>;
}

function usabilityLabel(usable: boolean | null) {
  if (usable === null) return 'Not evaluated';
  return usable ? 'Usable' : 'Unavailable';
}
function connectorKey(connector: SelfDiscoveryConnector) {
  const id = 'card' in connector ? connector.card.id : connector.ownerDid;
  const actingFor = 'selectors' in connector ? connector.selectors.actingFor ?? '' : '';
  return `${connector.provider}:${id}:${actingFor}`;
}
function ConnectorRow({ connector, agentDid }: Readonly<{ connector: SelfDiscoveryConnector; agentDid: string }>) {
  const ownerDid = 'billedPrincipal' in connector ? connector.billedPrincipal.did : connector.ownerDid;
  const unavailable = connector.usable === false || !connector.configured;
  const grade = connector.configured ? 'From config' : 'Unverified';
  const fix = connector.fix;
  return <li className={`space-y-2 rounded border p-3 ${unavailable ? 'border-red-800' : 'border-gray-800'}`}>
    <h4 className="font-semibold">{connector.provider} · {connector.family}</h4>
    <dl className="space-y-1">
      <Detail label="Authority / scope" value={connector.authority ?? 'Unknown'} />
      <Detail label="Config owner / billed DID" value={ownerDid} />
      <Detail label="Configured" value={connector.configured ? 'Yes' : 'No'} />
      <Detail label="Grant state" value={connector.grantStatus} />
      <Detail label="Live check" value={usabilityLabel(connector.usable)} />
      <Detail label="Grade" value={grade} />
      <Detail label="Outbound identity" value="Unknown — not observed by the kernel" />
      <Detail label="Usable models" value={connector.usableModels.join(', ') || 'None'} />
    </dl>
    {ownerDid !== agentDid && <p className="text-amber-300">Uses another principal&apos;s configuration — not the agent&apos;s own key.</p>}
    {'reason' in connector && connector.reason && <p className="text-red-300">{connector.reason.message}</p>}
    {fix && <div>
      <Link className="inline-block min-h-11 py-3 text-amber-300 underline" href={fix.href}>{fix.control}</Link>
      <p className="text-gray-400">Use acting identity: {fix.actingDid}</p>
    </div>}
  </li>;
}

export function AgentIdentityCard({ card }: Readonly<{ card: OperatorIdentityCard }>) {
  const { identity } = card;
  return <article aria-label={`Identity card for ${card.name || identity.handle || identity.did}`}
    className="min-w-0 space-y-3 rounded border border-gray-700 p-4 [overflow-wrap:anywhere]">
    <h3 className="text-base font-semibold">{card.name || identity.handle || identity.did}</h3>
    <dl className="space-y-1">
      <Detail label="DID" value={identity.did} />
      <Detail label="Handle" value={identity.handle ?? 'Unknown'} />
      <Detail label="Kind" value={identity.kind} />
      <Detail label="Tier" value={identity.tier} />
      <Detail label="Acts as organization" value={identity.actAs ?? 'None'} />
      <Detail label="Host / channels" value="Unknown — supplied only by the gateway" />
      <Detail label="Signature" value="Unavailable — this kernel projection is not an agent-signed card" />
    </dl>
    <ul className="space-y-3">{card.connectors.map(connector =>
      <ConnectorRow key={connectorKey(connector)}
        connector={connector} agentDid={identity.did} />)}</ul>
    {card.connectors.length === 0 && <p className="text-gray-400">No inference connector rows for this principal.
      {' '}<Link className="text-amber-300 underline" href="/auth/connectors">Configure connectors</Link></p>}
  </article>;
}
