/**
 * App-facing connector status surface (#1540).
 *
 * Apps may witness whether a user's profile-owned connectors are connected,
 * but they never receive connector credentials or config. This module reads
 * only active auth.channel_links rows and projects them through the static
 * connector registry as `{ id, connected, scopes }`.
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { CONNECTOR_REGISTRY, type ConnectorEntry } from './connector-registry';

export interface ConnectorConnectionStatus {
  id: string;
  connected: boolean;
  scopes: string[];
}

export interface ConnectorStatusRow {
  channel: string;
  appDid: string;
  scopes: unknown;
}

function scopeArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

function statusForConnector(
  connector: ConnectorEntry,
  rows: readonly ConnectorStatusRow[],
): ConnectorConnectionStatus {
  const validScopes = new Set(connector.scopes.map((scope) => scope.name));
  const activeScopes = new Set<string>();

  for (const row of rows) {
    if (row.channel !== connector.channel || row.appDid !== connector.connectorDid) {
      continue;
    }

    for (const scope of scopeArray(row.scopes)) {
      if (validScopes.has(scope)) {
        activeScopes.add(scope);
      }
    }
  }

  const scopes = connector.scopes.map((scope) => scope.name).filter((scope) => activeScopes.has(scope));

  return {
    id: connector.id,
    connected: scopes.length > 0,
    scopes,
  };
}

export function buildConnectorConnectionStatus(
  rows: readonly ConnectorStatusRow[],
  registry: readonly ConnectorEntry[] = CONNECTOR_REGISTRY,
): ConnectorConnectionStatus[] {
  return registry.map((connector) => statusForConnector(connector, rows));
}

export async function readConnectorConnectionStatus(ownerDid: string): Promise<ConnectorConnectionStatus[]> {
  const rows = await db
    .select({
      channel: channelLinks.channel,
      appDid: channelLinks.appDid,
      scopes: channelLinks.scopes,
    })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.status, 'active'),
      ),
    );

  return buildConnectorConnectionStatus(rows);
}
