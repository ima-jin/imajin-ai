/**
 * Which DIDs a person may pay a payment_request as (#2656 Phase 2).
 *
 * Ruling: any DID the person CONTROLS can pay an invoice — their own DID, plus
 * any org or business DID where they hold a controlling role in
 * `auth.identity_members`. The controlling roles are `owner` and `admin`; a
 * plain member (or maintainer/agent) can't move that identity's money, so can't
 * pay from it. A membership scoped to services that exclude `pay`
 * (`allowed_services`) doesn't count either, and a removed membership never does.
 *
 * This is the ONE definition of "controls", used both to build the picker
 * (`GET /pay/api/payment-requests/:handle/payer-dids`) and to enforce the
 * choice server-side (`resolvePayerDidChoice`, called by checkout and the
 * e-Transfer rail) — the UI only offers DIDs that qualify, and the server
 * rejects any that don't regardless of what the client sent.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, identityMembers, profiles } from '@/src/db';
import { findLiveRowByHandle, type ServiceError } from './service';

/** Roles that may move an identity's money — a subset of what act-as accepts (owner/admin/maintainer). */
export const PAYER_CONTROL_ROLES = ['owner', 'admin'] as const;

const PAY_SERVICE = 'pay';

export interface PayerDidOption {
  did: string;
  /** `personal` for the caller's own DID, `organization` for an org/business they control. */
  kind: 'personal' | 'organization';
  displayName: string;
}

/** The slice of an authenticated identity needed to find the person behind a request. */
export interface PayerIdentity {
  id: string;
  /** Set when an agent acts on a human's behalf (`X-Acting-For`). */
  actingFor?: string;
  /** Set when the person is operating as a group DID they control. */
  actingAs?: string;
}

/**
 * The person whose controlled DIDs may be chosen: the human an agent acts for,
 * else the signed-in identity itself. Group impersonation (`actingAs`) does NOT
 * change the person — they remain the signed-in human, who controls the group.
 */
export function payerPersonDidOf(identity: PayerIdentity): string {
  return identity.actingFor ?? identity.id;
}

type MembershipRow = { identityDid: string; allowedServices: string[] | null };

/** True when a membership's `allowed_services` scope (null = full access) covers `pay`. */
function coversPay(row: Pick<MembershipRow, 'allowedServices'>): boolean {
  return !row.allowedServices || row.allowedServices.includes(PAY_SERVICE);
}

/** `person`'s active, pay-capable owner/admin memberships, optionally narrowed to one identity. */
async function controllingMemberships(personDid: string, identityDid?: string): Promise<string[]> {
  const rows: MembershipRow[] = await db
    .select({ identityDid: identityMembers.identityDid, allowedServices: identityMembers.allowedServices })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.memberDid, personDid),
        inArray(identityMembers.role, [...PAYER_CONTROL_ROLES]),
        isNull(identityMembers.removedAt),
        ...(identityDid ? [eq(identityMembers.identityDid, identityDid)] : []),
      ),
    );
  return rows.filter(coversPay).map((row) => row.identityDid);
}

/** Display names keyed by DID; a DID with no profile falls back to a truncated DID. */
async function displayNamesFor(dids: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ did: profiles.did, displayName: profiles.displayName, handle: profiles.handle })
    .from(profiles)
    .where(inArray(profiles.did, dids));
  const names = new Map<string, string>();
  for (const row of rows) names.set(row.did, row.displayName || row.handle || row.did.slice(0, 16));
  return names;
}

/** Every DID `personDid` may pay as: themselves first, then the orgs/businesses they control (sorted by name). */
export async function listControlledPayerDids(personDid: string): Promise<PayerDidOption[]> {
  const orgDids = [...new Set(await controllingMemberships(personDid))].filter((did) => did !== personDid);
  const names = await displayNamesFor([personDid, ...orgDids]);
  const nameOf = (did: string) => names.get(did) ?? did.slice(0, 16);

  const orgs: PayerDidOption[] = orgDids
    .map((did) => ({ did, kind: 'organization' as const, displayName: nameOf(did) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [{ did: personDid, kind: 'personal', displayName: nameOf(personDid) }, ...orgs];
}

/** Whether `personDid` controls `did` — their own DID always; any other only through an owner/admin membership. */
export async function controlsPayerDid(personDid: string, did: string): Promise<boolean> {
  if (did === personDid) return true;
  return (await controllingMemberships(personDid, did)).length > 0;
}

/**
 * Validate a payer's chosen `paidByDid` (server-side enforcement of #2656).
 * Nothing chosen → `null` (the request settles as its recipient, as before).
 * A DID the person doesn't control → a 403 `ServiceError`; it is never stored.
 */
export async function resolvePayerDidChoice(
  paidByDid: string | null | undefined,
  personDid: string,
): Promise<string | null | ServiceError> {
  if (!paidByDid) return null;
  if (!(await controlsPayerDid(personDid, paidByDid))) {
    return { error: 'You are not authorized to pay as that identity', status: 403 };
  }
  return paidByDid;
}

export interface PayerDidChoices {
  dids: PayerDidOption[];
  /** Preselected in the picker: the request's recipient when the caller controls it, else the DID they're acting as, else themselves. */
  defaultDid: string;
}

/**
 * The picker's data for `GET /pay/api/payment-requests/:handle/payer-dids`:
 * the caller's own DID plus every org/business DID they control. 404 for an
 * unknown or void handle. Nothing about the request itself is returned — only
 * the caller's own identities — so any signed-in person may ask.
 */
export async function getPayerDidChoices(handle: string, identity: PayerIdentity): Promise<PayerDidChoices | ServiceError> {
  const row = await findLiveRowByHandle(handle);
  if (!row) return { error: 'payment_request not found', status: 404 };

  const personDid = payerPersonDidOf(identity);
  const dids = await listControlledPayerDids(personDid);
  const controlled = new Set(dids.map((option) => option.did));
  const actingDid = identity.actingFor ?? identity.actingAs ?? identity.id;
  const preferred = [row.recipientDid, actingDid].find((did): did is string => !!did && controlled.has(did));
  return { dids, defaultDid: preferred ?? personDid };
}
