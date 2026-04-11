import { getClient } from '@imajin/db';

const sql = getClient();

let cachedNodeDid: string | undefined;

/**
 * Returns this node's did:imajin DID.
 * Reads relay.relay_config.imajin_did from DB (cached for process lifetime).
 * Falls back to RELAY_DID env var, then empty string with a warning.
 */
export async function getNodeDid(): Promise<string> {
  if (cachedNodeDid !== undefined) return cachedNodeDid;

  try {
    const [row] = await sql`
      SELECT imajin_did FROM relay.relay_config WHERE id = 'singleton' LIMIT 1
    `;
    if (row?.imajin_did) {
      cachedNodeDid = row.imajin_did as string;
      return cachedNodeDid;
    }
  } catch (err) {
    console.warn('[node-identity] Could not read relay.relay_config:', err);
  }

  const fallback = process.env.RELAY_DID;
  if (fallback) {
    cachedNodeDid = fallback;
    return cachedNodeDid;
  }

  console.warn('[node-identity] No node DID found in relay.relay_config or RELAY_DID env');
  cachedNodeDid = '';
  return '';
}
