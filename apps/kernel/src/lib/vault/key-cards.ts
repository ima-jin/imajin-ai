/**
 * Vault key cards read model (#2247) — the timeline data behind the /jin
 * "Vault" section: one card per minted key, rendered as a TIMELINE (never a
 * value — there is no reveal/copy affordance anywhere in this codebase's
 * mint-in-vault path, because the private key material never leaves the
 * vault in the first place).
 *
 * Reads through the EXISTING kernel tables already used by the mint/grant/
 * ack machinery (`vault_minted_keys`, `vault_delegation_grants`) — no new
 * migration. See `apps/kernel/api-spec/vault.yaml` for the read endpoint
 * this backs (`GET /api/vault/mint/cards`).
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { db, vaultDelegationGrants, vaultMintedKeys, type VaultMintedKey, type VaultDelegationGrant } from '@/src/db';
import { vaultService, listActiveGrantsForField } from './index';
import { mintedKeyField } from './mint';

export type VaultKeyTimelineEventType = 'minted' | 'granted' | 'fetched' | 'acked' | 'rotated' | 'revoked';

export interface VaultKeyTimelineEvent {
  type: VaultKeyTimelineEventType;
  at: string;
  /** True for a 'fetched' row with no matching ack yet — the "honest record" red line (UX note #4). */
  alert?: boolean;
  detail: Record<string, unknown>;
}

export interface VaultKeyGrantSummary {
  grantId: string;
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  status: string;
  expiresAt: string | null;
  consumedAt: string | null;
  lastFetchedAt: string | null;
  ackedAt: string | null;
  ackOutcome: string | null;
  ackEvidence: { kind?: string; ref?: string; note?: string } | null;
  createdAt: string;
}

export interface VaultKeyCard {
  did: string;
  publicKey: string;
  purpose: string;
  requestedBy: string;
  mintedBy: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /** The grant this mint delivered the sealed key through, when one exists. */
  grant: VaultKeyGrantSummary | null;
  /**
   * EVERY currently active consumer grant for this key's field (#2298) —
   * not just `grant` above. A field can carry more than one active grant
   * once `grantExistingMintedKey` (#2247's "Grant access" button) issues a
   * second (or third, ...) consumer grant for the same field; that never
   * updates `grant`/`grantId`, which always names the ORIGINAL grant only.
   * May or may not include `grant` itself, depending on whether it is still
   * active.
   */
  grants: VaultKeyGrantSummary[];
  timeline: VaultKeyTimelineEvent[];
  /** "held in memory by <consumer>, last ack Nm ago" — null consumer/ack when never fetched/acked. */
  heldBy: string | null;
  lastAckAt: string | null;
  /** True when the current grant has been fetched at least once with no matching ack. */
  fetchWithoutAck: boolean;
}

function toGrantSummary(grant: VaultDelegationGrant): VaultKeyGrantSummary {
  return {
    grantId: grant.id,
    grantedTo: grant.grantedTo,
    purpose: grant.purpose,
    oneTime: grant.oneTime,
    status: grant.status,
    expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
    consumedAt: grant.consumedAt ? grant.consumedAt.toISOString() : null,
    lastFetchedAt: grant.lastFetchedAt ? grant.lastFetchedAt.toISOString() : null,
    ackedAt: grant.ackedAt ? grant.ackedAt.toISOString() : null,
    ackOutcome: grant.ackOutcome,
    ackEvidence: grant.ackEvidence ?? null,
    createdAt: grant.createdAt.toISOString(),
  };
}

function buildTimeline(row: VaultMintedKey, grant: VaultDelegationGrant | null): VaultKeyTimelineEvent[] {
  const timeline: VaultKeyTimelineEvent[] = [
    {
      type: 'minted',
      at: row.createdAt.toISOString(),
      detail: { by: row.mintedBy, purpose: row.purpose },
    },
  ];

  if (grant) {
    timeline.push({
      type: 'granted',
      at: grant.createdAt.toISOString(),
      detail: {
        to: grant.grantedTo,
        purpose: grant.purpose,
        oneTime: grant.oneTime,
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      },
    });

    if (grant.lastFetchedAt) {
      const acked = grant.ackedAt !== null;
      timeline.push({
        type: 'fetched',
        at: grant.lastFetchedAt.toISOString(),
        // #2243's loadFromVault helper doesn't exist on main yet, so there
        // is no host/telemetry column to read here — `grantedTo` (the
        // consumer DID) stands in for "host" until that lands. See the PR
        // description's open questions.
        alert: !acked,
        detail: { consumer: grant.grantedTo },
      });
    }

    if (grant.ackedAt) {
      timeline.push({
        type: 'acked',
        at: grant.ackedAt.toISOString(),
        detail: { outcome: grant.ackOutcome, evidence: grant.ackEvidence ?? null },
      });
    }
  }

  if (row.status === 'revoked' && row.revokedAt) {
    timeline.push({
      type: 'revoked',
      at: row.revokedAt.toISOString(),
      detail: { by: row.revokedBy },
    });
  }

  return timeline.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * List every minted key as a timeline card, newest mint first.
 *
 * One grant lookup batched across all minted keys (`inArray`) rather than
 * N+1 per-card queries — this endpoint renders the whole vault section in
 * one page load. Active-consumer grants (#2298) are looked up per distinct
 * field instead, via `listActiveGrantsForField` — deduped by field first,
 * since several minted keys never legitimately share one field in practice.
 */
export async function listVaultKeyCards(): Promise<VaultKeyCard[]> {
  const mintedKeys = await db
    .select()
    .from(vaultMintedKeys)
    .orderBy(desc(vaultMintedKeys.createdAt));

  const grantIds = mintedKeys.map((row) => row.grantId).filter((id): id is string => id !== null);
  const grantRows = grantIds.length > 0
    ? await db.select().from(vaultDelegationGrants).where(inArray(vaultDelegationGrants.id, grantIds))
    : [];
  const grantById = new Map(grantRows.map((row) => [row.id, row]));

  const fields = [...new Set(mintedKeys.map((row) => row.field))];
  const activeGrantsByFieldEntries = await Promise.all(
    fields.map(async (field): Promise<[string, VaultDelegationGrant[]]> => [field, await listActiveGrantsForField(field)]),
  );
  const activeGrantsByField = new Map(activeGrantsByFieldEntries);

  return mintedKeys.map((row) => {
    const grant = row.grantId ? grantById.get(row.grantId) ?? null : null;
    const fetchWithoutAck = grant !== null && grant.lastFetchedAt !== null && grant.ackedAt === null;
    const activeGrants = activeGrantsByField.get(row.field) ?? [];

    return {
      did: row.did,
      publicKey: row.publicKey,
      purpose: row.purpose,
      requestedBy: row.requestedBy,
      mintedBy: row.mintedBy,
      status: row.status as 'active' | 'revoked',
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedBy: row.revokedBy,
      grant: grant ? toGrantSummary(grant) : null,
      grants: activeGrants.map(toGrantSummary),
      timeline: buildTimeline(row, grant),
      heldBy: grant?.lastFetchedAt ? grant.grantedTo : null,
      lastAckAt: grant?.ackedAt ? grant.ackedAt.toISOString() : null,
      fetchWithoutAck,
    };
  });
}

export interface HandProvisionedField {
  field: string;
  senderDid: string;
  timestamp: string;
  custodyScheme: string;
  status: 'active' | 'deleted';
}

/**
 * Fields sealed OUTSIDE the mint-in-vault path (#2242) — the rotation-sweep
 * candidates (UX note #5: "filter 'hand-provisioned', rotate down the
 * list"). Derived by elimination: any vault entry whose field name is NOT
 * shaped like `mintedKeyField(did)` was never produced by `mintKeypair`, so
 * it was sealed some other way — `imajin-cli vault set`, a connector's
 * token-paste flow, or a raw `.env` value ported in by hand.
 *
 * This is a genuine heuristic, not a stored provenance flag: nothing in the
 * existing schema records "how was this field's value obtained". The one
 * theoretical false negative is a field manually named to start with
 * `vault-minted-key:` without actually going through `mintKeypair` — not
 * achievable through any UI or CLI path in this codebase today, but noted
 * in the PR description's open questions rather than silently assumed away.
 */
export async function listHandProvisionedFields(): Promise<HandProvisionedField[]> {
  const entries = await vaultService.list();
  return entries
    .filter((entry) => !entry.field.startsWith(mintedKeyField('')))
    .map((entry) => ({
      field: entry.field,
      senderDid: entry.senderDid,
      timestamp: entry.timestamp,
      custodyScheme: entry.custodyScheme ?? 'node-sealed',
      status: entry.deleted === true ? 'deleted' as const : 'active' as const,
    }));
}

/** Single-card lookup used by the vault-proposal execution bridge. */
export async function getMintedKeyByDid(did: string): Promise<VaultMintedKey | undefined> {
  const [row] = await db.select().from(vaultMintedKeys).where(eq(vaultMintedKeys.did, did)).limit(1);
  return row;
}
