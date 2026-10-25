/** Server-only corpus credential bridge. Never return these values to a browser. */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { GITHUB_CONNECTOR_DID, resolveActiveGrant, loadCorpusAccessToken } from './connector';
import { readReadAllowlist, isRepoAllowed } from './allowlist';
import { withConnectorConnection } from '../kernel/connector-connection-context';

export function corpusConnectorSlot(ref: unknown): string {
  if (typeof ref !== 'string' || !/^github:[a-z0-9][a-z0-9_-]{0,63}$/.test(ref)) {
    throw new Error('Select a GitHub connector for this source.');
  }
  return ref.slice('github:'.length);
}

export async function listCorpusGitHubConnectors(ownerDid: string) {
  const rows = await db.select({ slot: channelLinks.slot, scopes: channelLinks.scopes })
    .from(channelLinks).where(and(
      eq(channelLinks.did, ownerDid),
      eq(channelLinks.appDid, GITHUB_CONNECTOR_DID),
      eq(channelLinks.channel, 'github'),
      eq(channelLinks.status, 'active'),
    ));
  return [...new Set(rows.filter(row => Array.isArray(row.scopes) && row.scopes.includes('github:read')).map(row => row.slot))]
    .map(slot => ({ ref: `github:${slot}`, label: `GitHub · ${slot}` }));
}

/** Live grant + disclosure policy + vault OAuth lookup on every source operation. No PAT path. */
export async function resolveCorpusGitHubCredential(ownerDid: string, source: string, ref: unknown): Promise<string> {
  const slot = corpusConnectorSlot(ref);
  return withConnectorConnection('github', ownerDid, slot, async () => {
    if (!await resolveActiveGrant(ownerDid, 'github:read', slot)) {
      throw new Error('GitHub connector revoked or missing github:read permission.');
    }
    if (!isRepoAllowed(source.slice('github:'.length), await readReadAllowlist(ownerDid))) {
      throw new Error('GitHub repository is outside the connector disclosure allowlist.');
    }
    const token = await loadCorpusAccessToken(ownerDid, undefined, slot);
    if (!token) throw new Error('GitHub connector has no active OAuth credential.');
    return token;
  });
}
