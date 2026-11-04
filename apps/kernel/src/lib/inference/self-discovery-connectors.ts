import { CONNECTOR_REGISTRY } from '@/src/lib/kernel/connector-registry';
import { listConnectorRegistrations } from '@/src/lib/kernel/connector-registry-store';
import { POSTMAN_PROVIDER } from '@/src/lib/kernel/external-mcp-policy';
import { listBrainConnectors } from './brain';
import type { ConnectorFamily } from './self-discovery';

/** Metadata only: neither configuration nor an inference token proves tool authority. */
export async function listDiscoveryConnectorMetadata(actorDid: string) {
  // Only the signer's own rows. An infer grant must not reveal an assigned
  // principal's unrelated private connector configuration.
  const registrations = await listConnectorRegistrations(actorDid);
  const brains = new Set<string>(listBrainConnectors());
  const entries: { id: string; family: ConnectorFamily; href: string }[] = [
    ...CONNECTOR_REGISTRY.filter(entry => !brains.has(entry.id)).map(entry => ({
      id: entry.id, family: entry.id === 'mcp' ? 'mcp' as const : 'http' as const,
      href: `/auth/connectors/${encodeURIComponent(entry.id)}`,
    })),
    { id: POSTMAN_PROVIDER, family: 'mcp' as const, href: '/auth/connectors' },
  ];
  const known = new Set(entries.map(entry => entry.id));
  for (const row of registrations) {
    if (brains.has(row.provider) || known.has(row.provider) || row.provider.startsWith('org-held-')
      || row.provider.endsWith('-billing')) continue;
    known.add(row.provider);
    entries.push({ id: row.provider, family: 'http', href: '/auth/connectors' });
  }
  return entries.map(entry => ({
    provider: entry.id,
    family: entry.family,
    configured: registrations.some(row => row.provider === entry.id && row.status === 'active' && !row.revokedAt),
    ownerDid: actorDid,
    authority: null,
    grantStatus: 'not-evaluated' as const,
    usable: null,
    usableModels: [],
    fix: { control: 'Connectors → configuration and grants', href: entry.href, actingDid: actorDid },
  }));
}
