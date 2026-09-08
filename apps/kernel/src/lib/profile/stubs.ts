import { db, identityMembers, profiles, identities, storedKeys } from '@/src/db';
import { eq, and, isNull, count } from 'drizzle-orm';
import { generateKeypair } from '@imajin/auth';
import { didFromPublicKey, encryptPrivateKey } from '@/src/lib/auth/crypto';
import type { Logger } from '@imajin/logger';
import { randomUUID } from 'node:crypto';

type LoggerLike = Pick<Logger, 'error'>;

const ALLOWED_MAINTAINER_ROLES = new Set(['maintainer', 'admin', 'owner']);
export const MAX_STUBS_PER_ACTOR = 10;

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Check that the caller is a maintainer/admin/owner of the given stub identity. */
export async function checkStubMaintainerAccess(did: string, callerId: string): Promise<boolean> {
  const [membership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, did),
        eq(identityMembers.memberDid, callerId),
        isNull(identityMembers.removedAt),
      ),
    )
    .limit(1);

  return !!membership && ALLOWED_MAINTAINER_ROLES.has(membership.role);
}

export interface StubPatchFields {
  avatar?: string;
  banner?: string;
  name?: string;
  bio?: string;
  category?: string;
  location?: string;
  lat?: number;
  lon?: number;
}

/** Merge location/category/lat/lon fields into a stub's existing profile metadata. */
async function mergeStubMetadata(
  did: string,
  fields: Pick<StubPatchFields, 'category' | 'location' | 'lat' | 'lon'>,
): Promise<Record<string, unknown>> {
  const { category, location, lat, lon } = fields;
  const [existing] = await db
    .select({ metadata: profiles.metadata })
    .from(profiles)
    .where(eq(profiles.did, did))
    .limit(1);

  const newMeta: Record<string, unknown> = { ...(existing?.metadata as Record<string, unknown> | undefined) };
  if (category !== undefined) newMeta.category = category;
  if (location !== undefined) newMeta.location = location;
  if (lat !== undefined) newMeta.lat = lat;
  if (lon !== undefined) newMeta.lon = lon;
  return newMeta;
}

/**
 * Build the profile update patch for a stub PATCH request. Returns null when
 * no updatable field was supplied (the caller should respond 400).
 */
export async function buildProfilePatch(
  did: string,
  fields: StubPatchFields,
): Promise<Partial<typeof profiles.$inferInsert> | null> {
  const { avatar, banner, name, bio, category, location, lat, lon } = fields;
  const hasUpdate = avatar || banner || name !== undefined || bio !== undefined
    || category !== undefined || location !== undefined || lat !== undefined || lon !== undefined;
  if (!hasUpdate) return null;

  const profilePatch: Partial<typeof profiles.$inferInsert> = {};
  if (avatar) profilePatch.avatar = avatar;
  if (banner) profilePatch.banner = banner;
  if (name !== undefined) profilePatch.displayName = name;
  if (bio !== undefined) profilePatch.bio = bio;

  if (category !== undefined || location !== undefined || lat !== undefined || lon !== undefined) {
    profilePatch.metadata = await mergeStubMetadata(did, { category, location, lat, lon });
  }

  return profilePatch;
}

/** Whether the actor at `callerId` has already reached the maintained-stub quota. */
export async function checkStubQuota(callerId: string): Promise<boolean> {
  const [{ value: stubCount }] = await db
    .select({ value: count() })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.memberDid, callerId),
        eq(identityMembers.role, 'maintainer'),
        isNull(identityMembers.removedAt),
      ),
    );
  return stubCount >= MAX_STUBS_PER_ACTOR;
}

/** Whether a handle is already claimed by an existing identity. */
export async function isStubHandleTaken(handle: string): Promise<boolean> {
  const existing = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.handle, handle))
    .limit(1);
  return existing.length > 0;
}

/**
 * Generate a fresh Ed25519 keypair for a stub identity, encrypt and store
 * the private key, and insert the identity row. Returns the new stub DID.
 */
export async function createStubIdentity(params: {
  subtype?: string;
  handle?: string;
  trimmedName: string;
}): Promise<{ stubDid: string }> {
  const { subtype, handle, trimmedName } = params;

  const { privateKey, publicKey } = generateKeypair();
  const stubDid = didFromPublicKey(publicKey);

  const { encryptedKey, salt } = await encryptPrivateKey(privateKey);
  const keyId = genId('key');

  await db.insert(identities).values({
    id: stubDid,
    scope: 'business',
    subtype: subtype || null,
    publicKey,
    handle: handle || null,
    name: trimmedName,
    tier: 'preliminary',
  });

  await db.insert(storedKeys).values({
    id: keyId,
    did: stubDid,
    encryptedKey,
    salt,
    keyDerivation: 'pbkdf2',
  });

  return { stubDid };
}

/**
 * Build the metadata object for a new stub: location/category text plus
 * resolved coordinates. Coordinates come from the client if provided,
 * otherwise from a best-effort Nominatim geocode of the location text
 * (non-fatal on failure). Preserves the original field-write order exactly.
 */
export async function buildStubMetadata(params: {
  location?: string;
  category?: string;
  lat?: number;
  lon?: number;
  log: LoggerLike;
}): Promise<Record<string, string | number>> {
  const { location, category, lat, lon, log } = params;
  const metadata: Record<string, string | number> = {};
  if (location) metadata.location = String(location).slice(0, 200);
  if (category) metadata.category = String(category).slice(0, 100);

  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    metadata.lat = Math.round(lat * 1e6) / 1e6; // ~11cm precision
    metadata.lon = Math.round(lon * 1e6) / 1e6;
  }

  const resolved = await resolveStubCoordinates(location, lat, lon, log);
  if (resolved.lat != null) metadata.lat = String(resolved.lat);
  if (resolved.lon != null) metadata.lon = String(resolved.lon);

  return metadata;
}

/**
 * Server-side geocoding fallback: if no coords were provided by the client
 * but location text is present, query Nominatim. Returns the client-provided
 * coordinates unchanged when either is already present.
 */
async function resolveStubCoordinates(
  location: string | undefined,
  lat: number | undefined,
  lon: number | undefined,
  log: LoggerLike,
): Promise<{ lat: number | undefined; lon: number | undefined }> {
  if (lat || lon || !location) {
    return { lat, lon };
  }

  try {
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const geoRes = await fetch(geoUrl, {
      headers: { 'User-Agent': 'Imajin/1.0 (https://imajin.ai)' },
    });
    if (geoRes.ok) {
      const geoData = (await geoRes.json()) as Array<{ lat: string; lon: string }>;
      if (geoData.length > 0) {
        return { lat: Number.parseFloat(geoData[0].lat), lon: Number.parseFloat(geoData[0].lon) };
      }
    }
  } catch (err) {
    log.error({ err: String(err) }, '[stubs] Nominatim geocode failed (non-fatal)');
  }

  return { lat, lon };
}
