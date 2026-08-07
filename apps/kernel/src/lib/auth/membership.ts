/**
 * Shared vocabulary for `auth.identity_members` (#1680).
 *
 * Pure constants — safe to import from both server routes and client
 * components.
 */

/** Roles a membership row can hold. */
export const MEMBER_ROLES = ['owner', 'admin', 'maintainer', 'member', 'agent'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Roles a controller may assign through the Members UI.
 *
 * `owner` is excluded: ownership is established at identity creation and
 * transferred through a separate flow, not granted from this dropdown.
 */
export const ASSIGNABLE_MEMBER_ROLES: readonly MemberRole[] = [
  'admin',
  'maintainer',
  'member',
  'agent',
];

/**
 * How a member arrived. Stored in `auth.identity_members.added_via`.
 *
 * `null` means unknown — rows written before the column existed that the
 * backfill could not classify.
 */
export const MEMBER_ADDED_VIA = ['direct', 'invite', 'agent', 'claim'] as const;
export type MemberAddedVia = (typeof MEMBER_ADDED_VIA)[number];

export function isMemberAddedVia(value: unknown): value is MemberAddedVia {
  return typeof value === 'string' && (MEMBER_ADDED_VIA as readonly string[]).includes(value);
}

/** Human-readable label for a provenance value. */
export const MEMBER_ADDED_VIA_LABELS: Record<MemberAddedVia, string> = {
  direct: 'direct',
  invite: 'invite',
  agent: 'agent',
  claim: 'claim',
};

/** Longer explanation, used for tooltips. */
export const MEMBER_ADDED_VIA_DESCRIPTIONS: Record<MemberAddedVia, string> = {
  direct: 'Added manually by a controller through the UI',
  invite: 'Arrived via an invite code',
  agent: 'Added programmatically by an agent',
  claim: 'Stub claimed by the business owner',
};
