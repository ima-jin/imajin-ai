import { createLogger } from '@imajin/logger';
const log = createLogger('notify');

export async function send(params: {
  to: string;
  scope: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  urgency?: "low" | "normal" | "urgent";
}): Promise<void> {
  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!notifyUrl || !secret) {
    log.warn({}, "Notification skipped: NOTIFY_SERVICE_URL or NOTIFY_WEBHOOK_SECRET not set");
    return;
  }
  try {
    const res = await fetch(`${notifyUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ scope: params.scope, status: res.status, text }, `Notification (${params.scope}) failed: ${res.status} ${text}`);
    }
  } catch (err) {
    log.error({ err: String(err) }, `Notification (${params.scope}) error`);
  }
}

export async function broadcast(params: {
  scope: string;
  dids?: string[];
  subject: string;
  html: string;
  text?: string;
  channels?: ('email' | 'inapp' | 'chat')[];
}): Promise<void> {
  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!notifyUrl || !secret) {
    log.warn({}, "Broadcast skipped: NOTIFY_SERVICE_URL or NOTIFY_WEBHOOK_SECRET not set");
    return;
  }
  try {
    const res = await fetch(`${notifyUrl}/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ scope: params.scope, status: res.status, text }, `Broadcast (${params.scope}) failed: ${res.status} ${text}`);
    }
  } catch (err) {
    log.error({ err: String(err) }, `Broadcast (${params.scope}) error`);
  }
}

export async function interest(params: {
  did: string;
  attestationType: string;
}): Promise<void> {
  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!notifyUrl || !secret) {
    return;
  }
  try {
    const res = await fetch(`${notifyUrl}/api/interest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error({ attestationType: params.attestationType, status: res.status, text }, `Interest signal (${params.attestationType}) failed: ${res.status} ${text}`);
    }
  } catch (err) {
    log.error({ err: String(err) }, `Interest signal (${params.attestationType}) error`);
  }
}

export const notify = { send, broadcast, interest };
