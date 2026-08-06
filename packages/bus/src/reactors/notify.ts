import { send, interest } from '@imajin/notify';
import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:notify');

/**
 * `{{field}}` placeholders, where `field` is a single payload key.
 *
 * Deliberately not a general expression syntax: chain configs are operator-edited
 * rows, and a flat key lookup is the whole of what a notification title needs.
 * Bounded character classes keep this linear — no nested quantifier for a
 * DB-sourced string to backtrack through.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Render a configured title/body against the event payload.
 *
 * Only scalars substitute. An absent key, a null, or a nested object resolves to
 * the empty string rather than leaking `undefined`, `[object Object]`, or the raw
 * `{{field}}` into something a human reads. A config with no placeholders is
 * returned unchanged, so every chain config that predates this is unaffected.
 */
function interpolate(template: string, payload: Record<string, unknown> | undefined): string {
  return template.replaceAll(PLACEHOLDER, (_match, key: string) => {
    const value = payload?.[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  });
}

/** A configured string field, interpolated, or undefined when it is unset or blank. */
function resolveText(
  value: unknown,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const rendered = interpolate(value, payload).trim();
  return rendered.length === 0 ? undefined : rendered;
}

export const notifyReactor: ReactorHandler = async (event, config) => {
  const scope = (config.scope as string) || event.type;
  const template = config.template as string | undefined;

  // If interestDids is specified, send interest signals instead of (or in addition to) a notification
  const interestDids = event.payload?.interestDids as string[] | undefined;
  if (interestDids && Array.isArray(interestDids)) {
    for (const did of interestDids) {
      if (!did) continue;
      interest({ did, attestationType: event.type }).catch((err: unknown) => {
        log.error({ err: String(err), did, event: event.type }, 'Interest signal failed');
      });
    }
  }

  // Send notification to the subject (or override via config)
  const to = (config.to as string) || event.subject;
  const title = resolveText(config.title, event.payload);
  const body = resolveText(config.body, event.payload);

  // Only send if we have a recipient
  if (!to) {
    return;
  }

  await send({
    to,
    scope,
    title,
    body,
    data: {
      ...event.payload,
      eventType: event.type,
      issuer: event.issuer,
      subject: event.subject,
      correlationId: event.correlationId,
      template,
    },
  });
};
