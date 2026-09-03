/**
 * Agent identity minting (#1933: extracted from `POST /auth/api/agents` so
 * the envelope provisioner reuses the exact same identity-registration
 * primitive rather than re-implementing it — the issue's own instruction:
 * "Reuse these as libraries. Do not re-implement identity bootstrap").
 *
 * This is deliberately the same transaction shape `apps/kernel/app/auth/api/agents/route.ts`
 * always had: generate an Ed25519 keypair server-side, insert the `identities`
 * row, and insert both `identity_members` rows (owner + reverse role='agent')
 * atomically — if any step fails, the whole creation rolls back rather than
 * leaving an orphaned identity row with no owning membership link.
 */
import { db, identities, identityMembers } from '@/src/db';
import { eq } from 'drizzle-orm';
import { generateKeypair } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';

const HANDLE_REGEX = /^[a-z0-9_-]+$/;

export interface MintAgentIdentityInput {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  /** The DID that will own the new agent (identity_members 'owner' row + reverse 'agent' row). */
  actingDid: string;
}

export interface MintAgentIdentityResult {
  did: string;
  handle: string;
  displayName: string | null;
  keypair: { privateKey: string; publicKey: string };
  createdAt: string;
}

export class MintAgentIdentityError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'MintAgentIdentityError';
  }
}

export function validateHandle(handle: unknown): asserts handle is string {
  if (!handle || typeof handle !== 'string') {
    throw new MintAgentIdentityError('handle is required', 400);
  }
  if (handle.length < 3 || handle.length > 64) {
    throw new MintAgentIdentityError('Handle must be 3-64 characters', 400);
  }
  if (!HANDLE_REGEX.test(handle)) {
    throw new MintAgentIdentityError('Handle must be lowercase letters, numbers, underscores, or hyphens', 400);
  }
}

/**
 * Mint a brand-new agent identity owned by `actingDid`. Throws
 * `MintAgentIdentityError` (with an HTTP-shaped `status`) for validation and
 * conflict failures; callers translate that into their own response shape.
 */
export async function mintAgentIdentity(input: MintAgentIdentityInput): Promise<MintAgentIdentityResult> {
  validateHandle(input.handle);
  const handle = input.handle;
  const trimmedDisplayName = input.displayName?.trim().slice(0, 100) || null;

  const existing = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.handle, handle))
    .limit(1);
  if (existing.length > 0) {
    throw new MintAgentIdentityError('Handle already taken', 409);
  }

  const { privateKey, publicKey } = generateKeypair();
  const agentDid = didFromPublicKey(publicKey);

  const metadata: Record<string, unknown> = {};
  if (input.bio && typeof input.bio === 'string') {
    metadata.bio = input.bio.trim().slice(0, 500);
  }

  await db.transaction(async (tx) => {
    await tx.insert(identities).values({
      id: agentDid,
      scope: 'actor',
      subtype: 'agent',
      publicKey,
      handle,
      name: trimmedDisplayName,
      tier: 'preliminary',
      metadata: Object.keys(metadata).length > 0 ? metadata : {},
    });

    await tx.insert(identityMembers).values({
      identityDid: agentDid,
      memberDid: input.actingDid,
      role: 'owner',
      addedBy: input.actingDid,
      addedVia: 'direct',
    });

    await tx.insert(identityMembers).values({
      identityDid: input.actingDid,
      memberDid: agentDid,
      role: 'agent',
      addedBy: input.actingDid,
      addedVia: 'agent',
    });
  });

  return {
    did: agentDid,
    handle,
    displayName: trimmedDisplayName,
    keypair: { privateKey, publicKey },
    createdAt: new Date().toISOString(),
  };
}
