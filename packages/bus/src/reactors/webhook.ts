import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:webhook');

export const webhookReactor: ReactorHandler = async (event, config) => {
  const url = config.url as string;
  if (!url) {
    log.warn({ event: event.type }, 'Webhook reactor: no URL configured');
    return;
  }

  const secret = config.secret as string | undefined;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['x-webhook-secret'] = secret;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: event.type,
      issuer: event.issuer,
      subject: event.subject,
      scope: event.scope,
      payload: event.payload,
      timestamp: event.timestamp,
      correlationId: event.correlationId,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    log.error({ url, status: response.status, text, event: event.type }, 'Webhook delivery failed');
  }
};
