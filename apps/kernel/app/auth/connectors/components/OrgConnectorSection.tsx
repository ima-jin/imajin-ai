'use client';

import { useEffect, useState } from 'react';
import { CONNECTOR_REGISTRY } from '@/src/lib/kernel/connector-registry';
import { isAgentCapableSubtype } from '@/src/lib/kernel/connection-principal-policy';
import OrgConnectionsPanel from '../../components/OrgConnectionsPanel';
import { ConnectorDetail } from './ConnectorDetail';
import { loadedMetadata, sectionHeaders, type LoadedKey, type Member } from './ConnectorMode';
export type { OrgConnectorMode } from './ConnectorMode';

async function readGroup(orgDid: string, options: RequestInit): Promise<Group | null> {
  const response = await fetch(`/auth/api/groups/${encodeURIComponent(orgDid)}`, options);
  // Ordinary members cannot impersonate the group. They may still ask the
  // metadata-only endpoint, which independently enforces real membership.
  if (response.status === 403) return null;
  if (!response.ok) throw new Error('Organization membership read failed');
  const data: Group = await response.json();
  if (data.groupDid !== orgDid || !['business', 'community', 'family'].includes(data.scope)) {
    throw new Error('Organization identity mismatch');
  }
  return data;
}
interface Group {
  groupDid: string;
  scope: string;
  name: string | null;
  handle: string | null;
  viewerDid: string;
  viewerRole: string;
  controllers: Member[];
}
const serviceProviders = CONNECTOR_REGISTRY.filter(entry =>
  !entry.backendPending && ['static-secret', 'token-paste'].includes(entry.ingestionPattern));
function canManageGroup(group: Group, humanSession: boolean) {
  const viewer = group.controllers.find(member => member.controllerDid === group.viewerDid);
  return humanSession && ['owner', 'admin'].includes(group.viewerRole)
    && !!viewer && !isAgentCapableSubtype(viewer.subtype) && viewer.role !== 'agent'
    && (viewer.allowedServices === null || viewer.allowedServices.includes('connections'));
}

export default function OrgConnectorSection({ orgDid, humanSession, connectorId }: Readonly<{
  orgDid: string; humanSession: boolean; connectorId?: string;
}>) {
  const [group, setGroup] = useState<Group | null>(null);
  const [connections, setConnections] = useState<LoadedKey[] | null>(null);
  const [error, setError] = useState('');
  const [statusUnavailable, setStatusUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const options = { headers: sectionHeaders(orgDid), cache: 'no-store' as const, signal: controller.signal };
        const data = await readGroup(orgDid, options);
        const endpoint = data && canManageGroup(data, humanSession)
          ? '/connections/api/org-held'
          : `/connections/api/org-held/status?orgDid=${encodeURIComponent(orgDid)}`;
        const read = await fetch(endpoint, options);
        if (!read.ok && data === null) throw new Error('Organization status read denied');
        const keys = read.ok ? (await read.json()).connections
          .filter((value: LoadedKey) => value.status === 'loaded' && !!value.loadedAt
            && (!(data && canManageGroup(data, humanSession)) || !!value.loadedByDid))
          .map(loadedMetadata) : [];
        if (controller.signal.aborted) return;
        setGroup(data); setConnections(keys); setStatusUnavailable(!read.ok);
      } catch {
        if (!controller.signal.aborted) setError('Unable to load organization service keys.');
      }
    }
    void load();
    return () => controller.abort();
  }, [orgDid, humanSession]);

  const canManage = group !== null && canManageGroup(group, humanSession);
  const members = group?.controllers.filter(member => member.scope === 'actor' && !isAgentCapableSubtype(member.subtype) && member.role !== 'agent') ?? [];
  const label = group?.name || (group?.handle ? `@${group.handle}` : orgDid);
  return <section aria-label="Org service keys" className="mb-8 space-y-4">
    <h2 className="text-xl font-semibold text-white">Org service keys</h2>
    <p className="break-all text-sm text-gray-400">Keys held by {label}, not your personal identity. Only human owners and admins can load keys or manage member grants.</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!connections && !error && <p className="text-gray-400">Loading org service keys…</p>}
    {connections && <div className="grid items-start gap-4">{serviceProviders.filter(entry => !connectorId || entry.id === connectorId).map(entry =>
      <ConnectorDetail key={`${orgDid}:${entry.id}`} entry={entry} mode={{
        kind: 'org', orgDid, initial: connections.find(key => key.provider === entry.id),
        canManage, members, statusUnavailable,
      }} />)}</div>}
    {canManage && <OrgConnectionsPanel groupDid={orgDid} />}
  </section>;
}
