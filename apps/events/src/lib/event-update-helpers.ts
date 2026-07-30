/**
 * Helpers for the events PUT/PATCH route.
 * Extracted from app/api/events/[id]/route.ts to reduce cognitive complexity.
 */

const VALID_NAME_POLICIES = ['real_name', 'handle', 'anonymous', 'attendee_choice'] as const;

export interface EventUpdateBody {
  title?: unknown;
  description?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  timezone?: unknown;
  locationType?: unknown;
  isVirtual?: unknown;
  virtualUrl?: unknown;
  venue?: unknown;
  address?: unknown;
  city?: unknown;
  country?: unknown;
  imageUrl?: unknown;
  imageAssetId?: unknown;
  tags?: unknown;
  status?: unknown;
  metadata?: unknown;
  nameDisplayPolicy?: unknown;
  accessMode?: unknown;
  courseSlug?: unknown;
  emtEmail?: unknown;
  chatEnabled?: unknown;
}

/**
 * Build the full event update object from a PATCH/PUT request body.
 * Returns `{ error, status }` when validation fails (e.g. invalid nameDisplayPolicy).
 */
export function buildEventUpdates(
  body: EventUpdateBody,
): Record<string, unknown> | { error: string; status: number } {
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  applySimpleFieldUpdates(body, updates);
  applyDateFieldUpdates(body, updates);
  applyLocationFieldUpdates(body, updates);

  const policyResult = applyNamePolicyUpdate(body, updates);
  if (policyResult) return policyResult;

  applyNullableStringUpdates(body, updates);

  return updates;
}

/** Direct string/boolean/object field assignments — no validation needed. */
function applySimpleFieldUpdates(body: EventUpdateBody, updates: Record<string, unknown>): void {
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.virtualUrl !== undefined) updates.virtualUrl = body.virtualUrl;
  if (body.venue !== undefined) updates.venue = body.venue;
  if (body.address !== undefined) updates.address = body.address;
  if (body.city !== undefined) updates.city = body.city;
  if (body.country !== undefined) updates.country = body.country;
  if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl;
  if (body.imageAssetId !== undefined) updates.imageAssetId = body.imageAssetId;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.status !== undefined) updates.status = body.status;
  if (body.metadata !== undefined) updates.metadata = body.metadata;
  if (body.chatEnabled !== undefined) updates.chatEnabled = body.chatEnabled;
  if (body.accessMode !== undefined) updates.accessMode = body.accessMode;
}

/** Date/time field assignments — parse ISO strings to Date objects. */
function applyDateFieldUpdates(body: EventUpdateBody, updates: Record<string, unknown>): void {
  if (body.startsAt !== undefined) updates.startsAt = new Date(body.startsAt as string);
  if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? new Date(body.endsAt as string) : null;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
}

/** Location type handling — isVirtual is derived from locationType when provided. */
function applyLocationFieldUpdates(body: EventUpdateBody, updates: Record<string, unknown>): void {
  if (body.locationType !== undefined) {
    updates.locationType = body.locationType;
    updates.isVirtual = body.locationType !== 'physical';
  } else if (body.isVirtual !== undefined) {
    updates.isVirtual = body.isVirtual;
  }
}

/**
 * Validate and apply nameDisplayPolicy. Returns an error object when the
 * value is not in the allowed set, null when valid (or not present).
 */
function applyNamePolicyUpdate(
  body: EventUpdateBody,
  updates: Record<string, unknown>,
): { error: string; status: number } | null {
  if (body.nameDisplayPolicy === undefined) return null;
  if (!VALID_NAME_POLICIES.includes(body.nameDisplayPolicy as typeof VALID_NAME_POLICIES[number])) {
    return { error: 'Invalid nameDisplayPolicy', status: 400 };
  }
  updates.nameDisplayPolicy = body.nameDisplayPolicy;
  return null;
}

/** Nullable string fields — coerce empty strings to null. */
function applyNullableStringUpdates(body: EventUpdateBody, updates: Record<string, unknown>): void {
  if (body.courseSlug !== undefined) updates.courseSlug = body.courseSlug || null;
  if (body.emtEmail !== undefined) updates.emtEmail = body.emtEmail || null;
}

// ---------------------------------------------------------------------------
// Chat sync
// ---------------------------------------------------------------------------

/**
 * Best-effort sync of nameDisplayPolicy to the event's chat conversation
 * context. Errors are silently swallowed (non-fatal).
 */
export async function syncNamePolicyToChat(
  chatUrl: string,
  eventDid: string,
  nameDisplayPolicy: unknown,
): Promise<void> {
  try {
    const internalKey = process.env.AUTH_INTERNAL_API_KEY;
    await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/context`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(internalKey ? { Authorization: `Bearer ${internalKey}` } : {}),
      },
      body: JSON.stringify({ context: { nameDisplayPolicy } }),
    });
  } catch {
    // Best-effort sync — not fatal
  }
}
