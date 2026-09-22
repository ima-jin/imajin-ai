/**
 * Foreign-principal stub primitive (#2251) — a generalization of the
 * email-keyed claimable-stub primitive (#1834, ./claimable-stub.ts) for a
 * foreign agent's own principal: a human known to a foreign platform (e.g.
 * "Alice, a Meta Muse user") but unknown to Imajin, who discloses no PII to
 * us — not even an email.
 *
 * Keyed by a salted/peppered HMAC-SHA256 of `${platform}:${externalRef}`
 * (never the raw ref), so a foreign agent asking on behalf of the same
 * external principal more than once resolves to the same soft-tier stub DID
 * every time — same match-without-disclosure property as
 * `mintOrAccrueClaimableStub`: a caller cannot tell "first contact" from
 * "repeat contact" by response shape.
 *
 * No claim ratchet in this slice (unlike claim_stub_index) — the stub exists
 * purely as the `onBehalfOf` linkage target recorded on `agent.reach`
 * attestations (apps/kernel/src/lib/auth/agent-reach.ts). A claim path (the
 * foreign principal later showing up as a real Imajin identity and claiming
 * this stub) is explicit follow-up work — see the #2251 Phase 1 seam
 * proposal's "Explicitly NOT built in this slice" list.
 */
import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { db, identities, foreignPrincipalStubs } from '@/src/db';
import { getInternalSecret } from '@/src/lib/vault';

/** Purpose label for the vault-generated pepper (#2245) — see getInternalSecret. */
const PEPPER_PURPOSE = 'kernel.foreign-principal-pepper';

/**
 * Salted/peppered HMAC-SHA256 match key for a `(platform, externalRef)`
 * pair. Never reversible; used only for equality matching against
 * `auth.foreign_principal_stubs.external_ref_hmac`.
 *
 * The pepper is a kernel-internal, self-provisioned vault secret (#2245) —
 * generated on first use and self-granted to the node's own DID, never a
 * hand-set env var. See `@/src/lib/vault/internal-secret.ts`.
 */
export async function hmacForeignPrincipalRef(platform: string, externalRef: string): Promise<string> {
  const pepper = await getInternalSecret(PEPPER_PURPOSE);
  return createHmac('sha256', pepper).update(`${platform}:${externalRef}`).digest('hex');
}

export interface ForeignPrincipalStubResult {
  did: string;
  /** True only when this call minted a brand-new stub; false on silent accrual to an existing one. */
  isNewStub: boolean;
}

/**
 * Mint-or-accrue a claimable stub identity for a foreign agent's declared
 * principal. A dedup-index hit returns the same DID silently; a miss mints a
 * new soft-tier, no-PII identity plus its index row.
 */
export async function resolveOrMintForeignPrincipalStub(params: {
  platform: string;
  externalRef: string;
}): Promise<ForeignPrincipalStubResult> {
  const { platform } = params;
  const externalRefHmac = await hmacForeignPrincipalRef(platform, params.externalRef);

  const [existing] = await db
    .select({ stubDid: foreignPrincipalStubs.stubDid })
    .from(foreignPrincipalStubs)
    .where(and(eq(foreignPrincipalStubs.platform, platform), eq(foreignPrincipalStubs.externalRefHmac, externalRefHmac)))
    .limit(1);
  if (existing) {
    return { did: existing.stubDid, isNewStub: false };
  }

  const did = `did:imajin:${nanoid(44)}`;
  await db.insert(identities).values({
    id: did,
    scope: 'actor',
    subtype: 'human',
    publicKey: `stub_${nanoid(32)}`,
    tier: 'soft',
    metadata: { source: 'agent.reach', foreignPlatform: platform, stub: true },
  });

  await db.insert(foreignPrincipalStubs).values({
    id: `fpstub_${nanoid(32)}`,
    platform,
    externalRefHmac,
    stubDid: did,
  });

  return { did, isNewStub: true };
}

/**
 * Find the DID of an existing foreign-principal stub, without minting a new
 * one. Returns `null` when no stub exists yet for this `(platform,
 * externalRef)` pair.
 */
export async function findForeignPrincipalStubDid(platform: string, externalRef: string): Promise<string | null> {
  const externalRefHmac = await hmacForeignPrincipalRef(platform, externalRef);
  const [stub] = await db
    .select({ stubDid: foreignPrincipalStubs.stubDid })
    .from(foreignPrincipalStubs)
    .where(and(eq(foreignPrincipalStubs.platform, platform), eq(foreignPrincipalStubs.externalRefHmac, externalRefHmac)))
    .limit(1);
  return stub?.stubDid ?? null;
}
