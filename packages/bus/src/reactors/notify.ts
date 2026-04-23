import { send, interest } from '@imajin/notify';
import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:notify');

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
  const title = (config.title as string) || undefined;
  const body = (config.body as string) || undefined;

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
