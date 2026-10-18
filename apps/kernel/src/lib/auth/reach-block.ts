import { getClient } from '@imajin/db';
import { didFromPublicKey } from './crypto';

export const REACH_SENDER_DAILY_CAP = 25;

export type ReachBlockReader = Pick<ReturnType<typeof getClient>, 'unsafe'>;

export interface ReachBlockParams {
  principalDid: string;
  requesterDid: string;
  onBehalfOfStubDid?: string;
  /** Only a signature-verified key, never an unverified transport hint. */
  publicKey?: string;
}

interface ForeignSender {
  stub_did: string;
  requester_did: string;
  signer_key: string;
  requester_aliases: string[];
  signer_aliases: string[];
  promoted_to: string | null;
  revoked_at: Date | null;
}

function signerDid(key: string): string[] {
  return /^[0-9a-f]{64}$/i.test(key) ? [didFromPublicKey(key.toLowerCase())] : [];
}

function senderIdentities(sender: ForeignSender): string[] {
  return [
    sender.stub_did, sender.requester_did, ...sender.requester_aliases,
    ...(sender.promoted_to ? [sender.promoted_to] : []),
    ...[sender.signer_key, ...sender.signer_aliases].flatMap(signerDid),
  ];
}

/**
 * Resolve only identities already linked by verified foreign-agent credentials.
 * The claimed human is a block candidate, never proof of an agent/key alias.
 * A fixed point also handles historical rows joined by a verified key rotation.
 */
export async function reachSenderGroup(reader: ReachBlockReader, params: ReachBlockParams): Promise<{
  identities: string[];
  stubDids: string[];
  revoked: boolean;
}> {
  const rows = await reader.unsafe<ForeignSender[]>(`
    SELECT stub_did, requester_did, signer_key, requester_aliases, signer_aliases, promoted_to, revoked_at
    FROM auth.foreign_agent_stubs WHERE principal_did = $1
  `, [params.principalDid]);
  const identities = new Set([params.requesterDid, ...(params.publicKey ? signerDid(params.publicKey) : [])]);
  const stubDids = new Set<string>();
  let revoked = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const sender of rows) {
      if (stubDids.has(sender.stub_did)) continue;
      const aliases = senderIdentities(sender);
      if (!aliases.some((identity) => identities.has(identity))) continue;
      stubDids.add(sender.stub_did);
      for (const identity of aliases) identities.add(identity);
      revoked ||= sender.revoked_at !== null;
      changed = true;
    }
  }
  return { identities: [...identities], stubDids: [...stubDids], revoked };
}

/** The same check is rerun inside the delivery transaction after its principal lock. */
export async function isReachSenderBlockedInTransaction(
  reader: ReachBlockReader,
  params: ReachBlockParams,
): Promise<boolean> {
  const group = await reachSenderGroup(reader, params);
  if (group.revoked) return true;
  const candidates = [...group.identities, ...(params.onBehalfOfStubDid ? [params.onBehalfOfStubDid] : [])];
  const blocked = await reader.unsafe(`
    SELECT 1 FROM auth.reach_sender_blocks
    WHERE principal_did = $1 AND $2::jsonb ? requester_did LIMIT 1
  `, [params.principalDid, JSON.stringify(candidates)]);
  return blocked.length > 0;
}

/**
 * Call after signature verification and claimed-principal resolution, before
 * broker evaluation. Uses the owner's existing block list, including for asks.
 * Database failures deliberately propagate: callers must not fail open.
 */
export function isReachSenderBlocked(params: ReachBlockParams): Promise<boolean> {
  return isReachSenderBlockedInTransaction(getClient(), params);
}
