import { createLogger } from '@imajin/logger';
import { getChainConfig } from './config';
import { getReactor } from './registry';
import type { BusEvent } from './types';

const log = createLogger('bus:app-event');

/**
 * Reactor types an app-emitted event may ever trigger (#2638 / #2641, ruled
 * "b"): notify and audit only — never money. Settle, MJN emission and
 * attestation issuance are NOT here, and cannot be added by chain config:
 * this set is the ceiling, the configured chain is only ever intersected
 * with it.
 */
export const APP_EVENT_REACTORS: ReadonlySet<string> = new Set(['notify', 'audit-log']);

/** `scope` every app-emitted event carries; the emitting app is named by `issuer` and `payload.originAppDid`. */
export const APP_EVENT_SCOPE = 'apps';

/**
 * Payload keys the kernel owns on an app-origin event. An app-supplied value
 * is dropped, never trusted:
 *  - `origin` / `originAppDid` — kernel-stamped provenance for the audit trail.
 *  - `preview` — the audit-log reactor skips the write when it is `true`, so an
 *    app could otherwise opt itself out of the audit trail.
 *  - `attestationId` — reactor-to-reactor hand-off slot, never caller input.
 */
const RESERVED_PAYLOAD_KEYS = ['origin', 'originAppDid', 'preview', 'attestationId'] as const;

export interface AppEventInput {
  /** DID the event is about / the notification recipient. */
  subject: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
}

export interface AppEventResult {
  eventType: string;
  /** DID of the emitting app — recorded as the event's issuer and `payload.originAppDid`. */
  origin: string;
  /** Reactor types that ran, in order. */
  ran: string[];
  /** Reactor types in the configured chain that were refused for an app-origin event. */
  skipped: string[];
}

function sanitizePayload(payload: Record<string, unknown> | undefined, appDid: string): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...payload };
  for (const key of RESERVED_PAYLOAD_KEYS) delete clean[key];
  return { ...clean, origin: 'app', originAppDid: appDid };
}

async function runReactor(type: string, config: Record<string, unknown>, event: BusEvent): Promise<boolean> {
  const handler = getReactor(type);
  if (!handler) {
    log.error({ reactor: type, event: event.type }, 'App-event reactor not registered');
    return false;
  }
  try {
    await handler(event, config);
    return true;
  } catch (err) {
    log.error({ err: String(err), reactor: type, event: event.type }, 'App-event reactor threw');
    return false;
  }
}

/**
 * Publish an event on behalf of a registered app (#2638 / #2641).
 *
 * Unlike {@link publish}, which runs whatever the chain config says, this runs
 * the configured chain *intersected with* {@link APP_EVENT_REACTORS}:
 *  1. one `audit-log` write, always, naming the app as origin — before anything
 *     else, so the record exists even if a notification then fails;
 *  2. the chain's `notify` reactor(s), if it has any.
 * Every other reactor in the chain (settle, mjn, attestation, emit, …) is
 * skipped and reported in `skipped`. Event-subscription fan-out is not run for
 * app-origin events either.
 *
 * The CALLER is responsible for authenticating the app and checking the
 * operator-approved allowlist; this function only bounds what an accepted
 * event can do.
 */
export async function publishAppEvent(type: string, event: AppEventInput, appDid: string): Promise<AppEventResult> {
  const fullEvent: BusEvent = {
    type,
    issuer: appDid,
    subject: event.subject,
    scope: APP_EVENT_SCOPE,
    payload: sanitizePayload(event.payload, appDid),
    correlationId: event.correlationId,
    timestamp: new Date().toISOString(),
  };

  const chain = await getChainConfig(type, APP_EVENT_SCOPE);
  const enabled = chain.reactors.filter((r) => r.enabled);
  const notifyReactors = enabled.filter((r) => r.type === 'notify');
  const skipped = enabled.filter((r) => !APP_EVENT_REACTORS.has(r.type)).map((r) => r.type);

  if (skipped.length > 0) {
    log.info({ event: type, appDid, skipped }, 'App-origin event: refused non-notify/audit reactors from chain');
  }

  const ran: string[] = [];
  if (await runReactor('audit-log', {}, fullEvent)) ran.push('audit-log');
  for (const reactor of notifyReactors) {
    if (await runReactor('notify', reactor.config, fullEvent)) ran.push('notify');
  }

  return { eventType: type, origin: appDid, ran, skipped };
}
