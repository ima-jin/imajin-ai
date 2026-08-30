/**
 * Attestation type registry (#1885) — registry-as-data.
 *
 * `@imajin/auth`'s ATTESTATION_TYPES stays a compile-time array covering
 * the ~59 pre-existing platform types plus the 5 platform-seeded
 * intro-funnel types (validated with zero DB hits). This module is the
 * *extension* surface: third parties register new types under their own
 * namespace, gated by trust tier (requireEstablishedDID), so the vocabulary
 * can grow without a PR to this repo while still forfeiting nothing for the
 * hardcoded fast path.
 */
import { db, attestationTypeRegistry, identities } from '@/src/db';
import { eq, isNull, and } from 'drizzle-orm';

const NAMESPACE_SEPARATOR = '/';

export interface AttestationTypeRegistryEntry {
  typeName: string;
  namespace: string;
  registeredByDid: string | null;
  description: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** True when `type` is a live (non-revoked) entry in the registry. */
export async function isRegisteredAttestationType(type: string): Promise<boolean> {
  const [row] = await db
    .select({ typeName: attestationTypeRegistry.typeName })
    .from(attestationTypeRegistry)
    .where(and(eq(attestationTypeRegistry.typeName, type), isNull(attestationTypeRegistry.revokedAt)))
    .limit(1);
  return Boolean(row);
}

/** All live registry entries, platform and third-party, in registration order. */
export async function listRegisteredAttestationTypes(): Promise<AttestationTypeRegistryEntry[]> {
  return db
    .select()
    .from(attestationTypeRegistry)
    .where(isNull(attestationTypeRegistry.revokedAt));
}

export type RegisterAttestationTypeResult =
  | { ok: true; entry: AttestationTypeRegistryEntry }
  | { ok: false; error: string };

/**
 * Register a third-party attestation type. The caller's namespace is always
 * their own handle — nobody can register into someone else's namespace or
 * the reserved `platform` namespace, which prevents impersonation of the
 * platform-seeded funnel vocabulary.
 *
 * `localName` is the part after the namespace prefix, e.g. registering
 * `localName: "referral_made"` for handle `acme` yields `acme/referral_made`.
 */
export async function registerAttestationType(params: {
  registeredByDid: string;
  handle: string;
  localName: string;
  description?: string;
}): Promise<RegisterAttestationTypeResult> {
  const { registeredByDid, handle, localName, description } = params;

  if (!handle) {
    return { ok: false, error: 'Registering identity has no handle to namespace types under' };
  }
  if (handle === 'platform') {
    return { ok: false, error: 'The "platform" namespace is reserved' };
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(localName)) {
    return { ok: false, error: 'localName must be lowercase alphanumeric with . _ - separators (max 64 chars)' };
  }

  const typeName = `${handle}${NAMESPACE_SEPARATOR}${localName}`;

  const [existing] = await db
    .select({ typeName: attestationTypeRegistry.typeName, revokedAt: attestationTypeRegistry.revokedAt })
    .from(attestationTypeRegistry)
    .where(eq(attestationTypeRegistry.typeName, typeName))
    .limit(1);
  if (existing && !existing.revokedAt) {
    return { ok: false, error: `Type "${typeName}" is already registered` };
  }

  const [entry] = await db
    .insert(attestationTypeRegistry)
    .values({
      typeName,
      namespace: handle,
      registeredByDid,
      description: description ?? null,
    })
    .onConflictDoUpdate({
      target: attestationTypeRegistry.typeName,
      set: { registeredByDid, description: description ?? null, revokedAt: null },
    })
    .returning();

  return { ok: true, entry };
}

/** Resolve the DID's handle, or null if it has none set. */
export async function resolveHandleForDid(did: string): Promise<string | null> {
  const [row] = await db
    .select({ handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);
  return row?.handle ?? null;
}
