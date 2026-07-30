/**
 * Helpers for the ticket-tiers PUT route.
 * Extracted from app/api/events/[id]/tiers/route.ts to reduce cognitive complexity.
 */

export interface TierUpdateBody {
  name?: unknown;
  description?: unknown;
  price?: unknown;
  currency?: unknown;
  quantity?: unknown;
  perks?: unknown;
  sortOrder?: unknown;
  requiresRegistration?: unknown;
  registrationFormId?: unknown;
  accessCode?: unknown;
}

export interface TierRecord {
  sold?: number | null;
  price: number;
  currency: string;
  perks: unknown;
}

export interface TierUpdateResult {
  updates: Record<string, unknown>;
  violations: string[];
}

/**
 * Validate and build the tier update object applying the append-only policy:
 * - price and currency can only change before any tickets are sold
 * - price can decrease (but not increase) after tickets are sold
 * - quantity must remain >= sold count
 * - perks can only be added, never removed, after tickets are sold
 *
 * Returns `{ updates, violations }`. The caller should check violations.length > 0.
 */
export function buildTierUpdates(body: TierUpdateBody, tier: TierRecord): TierUpdateResult {
  const updates: Record<string, unknown> = {};
  const violations: string[] = [];
  const sold = tier.sold || 0;

  applyFreelyEditableFields(body, updates);
  validateAndApplyCurrency(body, tier, sold, updates, violations);
  validateAndApplyPrice(body, tier, sold, updates, violations);
  validateAndApplyQuantity(body, sold, updates, violations);
  validateAndApplyPerks(body, tier, sold, updates, violations);

  return { updates, violations };
}

function applyFreelyEditableFields(body: TierUpdateBody, updates: Record<string, unknown>): void {
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
  if (body.requiresRegistration !== undefined) updates.requiresRegistration = body.requiresRegistration;
  if (body.registrationFormId !== undefined) updates.registrationFormId = body.registrationFormId || null;
  if (body.accessCode !== undefined) {
    updates.accessCode = typeof body.accessCode === 'string' ? body.accessCode.trim() || null : null;
  }
}

function validateAndApplyCurrency(
  body: TierUpdateBody,
  tier: TierRecord,
  sold: number,
  updates: Record<string, unknown>,
  violations: string[],
): void {
  if (body.currency === undefined) return;
  if (sold === 0) {
    updates.currency = body.currency;
  } else if (body.currency !== tier.currency) {
    violations.push('currency cannot be changed after tickets are sold');
  }
}

function validateAndApplyPrice(
  body: TierUpdateBody,
  tier: TierRecord,
  sold: number,
  updates: Record<string, unknown>,
  violations: string[],
): void {
  if (body.price === undefined) return;
  const price = body.price as number;
  if (sold === 0) {
    updates.price = price;
  } else if (price > tier.price) {
    violations.push(
      `price can only decrease after tickets are sold (current: ${tier.price}, requested: ${price})`,
    );
  } else {
    updates.price = price;
  }
}

function validateAndApplyQuantity(
  body: TierUpdateBody,
  sold: number,
  updates: Record<string, unknown>,
  violations: string[],
): void {
  if (body.quantity === undefined) return;
  const quantity = body.quantity as number | null;
  if (quantity !== null && quantity < sold) {
    violations.push(
      `quantity cannot be less than sold count (sold: ${sold}, requested: ${quantity})`,
    );
  } else {
    updates.quantity = quantity;
  }
}

function validateAndApplyPerks(
  body: TierUpdateBody,
  tier: TierRecord,
  sold: number,
  updates: Record<string, unknown>,
  violations: string[],
): void {
  if (body.perks === undefined) return;
  if (sold === 0) {
    updates.perks = body.perks;
    return;
  }
  // Tickets sold — can only add, not remove
  const currentPerks = (tier.perks as string[]) || [];
  const newPerks = body.perks as string[];
  const removedPerks = currentPerks.filter((p) => !newPerks.includes(p));
  if (removedPerks.length > 0) {
    violations.push(`cannot remove perks after tickets are sold: ${removedPerks.join(', ')}`);
  } else {
    updates.perks = newPerks;
  }
}
