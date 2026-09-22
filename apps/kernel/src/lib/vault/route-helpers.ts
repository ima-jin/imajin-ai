import { publish } from '@imajin/bus';
import type { BusEventMap, BusEventType } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * HTTP status + error message shared by every grantId-scoped vault
 * delegation-grant route (`.../fetch`, `.../ack`, ...) for the
 * anti-enumeration pair of outcomes: a caller must never be able to tell
 * "this grantId doesn't exist" apart from "this grantId exists but isn't
 * yours" — both collapse to an identical 404 with an identical message.
 *
 * Extracted once both routes needed it (#2235 review — SonarCloud flagged
 * the near-verbatim duplication between fetch/route.ts and ack/route.ts)
 * so the two call sites can never drift out of sync.
 */
export const GRANT_NOT_FOUND_STATUS = 404;
export const GRANT_NOT_FOUND_ERROR = 'No delegation grant found for this id';

/**
 * Fire-and-forget bus publish for a vault-delegation audit event.
 *
 * Never throws and never fails the caller's request — a publish failure is
 * logged and swallowed, matching every vault delegation route's existing
 * audit-publish behaviour (`vault.delegation.fetched`, `.acked`, ...).
 * Callers are responsible for building a payload that never carries the
 * secret value, the free-text `note`, or `evidence.ref`.
 */
export function publishVaultDelegationAudit<T extends BusEventType>(
  eventType: T,
  granteeDid: string,
  grantId: string,
  payload: BusEventMap[T],
): void {
  publish(eventType, {
    issuer: granteeDid,
    subject: granteeDid,
    scope: 'vault',
    payload,
  }).catch((err: unknown) => {
    log.error({ err: String(err), grantId }, `Bus publish error for ${eventType}`);
  });
}
