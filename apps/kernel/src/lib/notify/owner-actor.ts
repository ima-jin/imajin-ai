/**
 * Owner-facing actor/principal rendering (#2366).
 *
 * ## The inversion this closes
 * An owner alert is the one surface whose job is to tell the owner WHO is
 * touching their stuff. Under the app-token lane (#1926) a delegate acts with
 * `azp` = the app and `sub` = the principal, so a notification built only from
 * `sub` renders the owner's own DID as both requester and subject — a delegate
 * acting as the principal becomes indistinguishable from the principal. That is
 * exactly the inversion the signed record exists to prevent.
 *
 * Every owner-facing notification built from a `{did, appDid}` context routes
 * its actor phrasing through this module so the rule is stated once:
 *
 *   appDid absent, or appDid === did  →  first-party: "<label> <action>"
 *   appDid !== did                    →  delegated:   "<label> <action> on behalf of you"
 *
 * `label` prefers a human name the producer supplied (`actorLabel`) and falls
 * back to the shortened acting DID, so the alert always names the ACTING party
 * — never the principal standing in for them.
 *
 * Deliberately pure and dependency-free: it is imported by the notify template
 * table, which is evaluated for both the in-app and email legs.
 */

/** DIDs longer than this are elided in the middle for display. */
const DID_DISPLAY_MAX = 30;
const DID_HEAD = 20;
const DID_TAIL = 6;

/** The `{did, appDid}` context every owner-facing notification is built from. */
export interface OwnerActorContext {
  /**
   * The principal the action was taken for — the access token's `sub`, i.e.
   * the notification recipient themself on an owner-facing alert.
   */
  did?: unknown;
  /**
   * The ACTING party's app DID — the access token's `azp`. Absent on a true
   * first-party request; equal to `did` when the principal acted directly.
   */
  appDid?: unknown;
  /**
   * The DID the request is attributed to, when the producer records one apart
   * from the principal — e.g. a broker request's `requesterDid`.
   *
   * Used as the acting party ONLY when no delegate is named, which keeps two
   * genuinely different situations apart: a third party asking for the owner's
   * data is not "on behalf of" the owner, whereas a delegate carrying the
   * owner's own `sub` is.
   */
  requesterDid?: unknown;
  /** Optional human-readable name for the acting party, preferred over its DID. */
  actorLabel?: unknown;
}

/** The resolved actor/principal pair an owner-facing template renders from. */
export interface OwnerActor {
  /** Display text for the ACTING party: its label when known, else its shortened DID. */
  label: string;
  /** The acting party's DID — `appDid` when delegated, otherwise the principal's own. */
  actorDid: string;
  /** The principal the action was taken for. */
  principalDid: string;
  /** True when a delegate acted for the principal (`appDid` present and !== `did`). */
  onBehalfOfOwner: boolean;
}

/** Narrow an unknown context field to a non-empty trimmed string, else `''`. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Elide the middle of a long DID for display (`did:imajin:ADEK…n54k`). Short
 * values and non-DID labels are returned unchanged.
 */
export function shortenDid(did: string): string {
  if (did.length <= DID_DISPLAY_MAX) return did;
  return `${did.slice(0, DID_HEAD)}\u2026${did.slice(-DID_TAIL)}`;
}

/**
 * Resolve the acting party and the principal from a `{did, appDid}` context.
 *
 * Actor precedence: the delegate (`appDid`) when it is present and distinct
 * from the principal, else the attributed `requesterDid`, else the principal
 * itself. Only the first case is "on behalf of" — so a legacy payload carrying
 * nothing but `requesterDid` resolves exactly as it always did.
 *
 * `fallbackLabel` is what an alert says when neither side identified itself
 * (e.g. `'Someone'`), preserving each template's existing anonymous copy.
 */
export function resolveOwnerActor(
  ctx: Readonly<OwnerActorContext>,
  fallbackLabel = 'Someone',
): OwnerActor {
  const principalDid = asText(ctx.did);
  const appDid = asText(ctx.appDid);
  const onBehalfOfOwner = appDid !== '' && appDid !== principalDid;
  const actorDid = onBehalfOfOwner ? appDid : asText(ctx.requesterDid) || principalDid;
  const label = asText(ctx.actorLabel) || shortenDid(actorDid) || fallbackLabel;

  return { label, actorDid, principalDid, onBehalfOfOwner };
}

/**
 * Compose one owner-facing sentence naming the acting party.
 *
 * `action` is the verb phrase the alert is about, e.g.
 * `'requested your document.projection'`. A delegated request gains the
 * `on behalf of you` clause; a first-party one keeps the existing one-DID form
 * verbatim, so nothing changes for requests the owner genuinely made.
 */
export function ownerActorSentence(actor: Readonly<OwnerActor>, action: string): string {
  return actor.onBehalfOfOwner
    ? `${actor.label} ${action} on behalf of you`
    : `${actor.label} ${action}`;
}

/**
 * One-shot convenience over {@link resolveOwnerActor} + {@link ownerActorSentence}
 * for templates that need nothing else from the resolved pair.
 */
export function ownerActionTitle(
  ctx: Readonly<OwnerActorContext>,
  action: string,
  fallbackLabel = 'Someone',
): string {
  return ownerActorSentence(resolveOwnerActor(ctx, fallbackLabel), action);
}
