import { createLogger } from '@imajin/logger';
import { getVaultInternalApiKey } from '@imajin/auth';
const log = createLogger('notify');
export interface NotifyConfiguration {
  /** Defaults to NOTIFY_SERVICE_URL (a URL, never a credential). */
  serviceUrl?: string;
  /** Return a fresh/cached vault app-service token with approved notify scopes. */
  appTokenProvider?: () => string | undefined | Promise<string | undefined>;
  /** Internal callers only: supply the vault-resolved internal API key. */
  internalSecretProvider?: () => string | undefined | Promise<string | undefined>;
}

// Instrumentation and route handlers can be separately bundled by Next.js.
const NOTIFY_CONFIGURATION = Symbol.for('@imajin/notify/configuration');
const globalState = globalThis as { [NOTIFY_CONFIGURATION]?: NotifyConfiguration };

/** Configure at boot. Existing send/broadcast/interest call signatures remain unchanged. */
export function configureNotify(options: NotifyConfiguration): void {
  globalState[NOTIFY_CONFIGURATION] = { ...options };
}

async function transport(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const configuration = globalState[NOTIFY_CONFIGURATION] ?? {};
  const url = configuration.serviceUrl ?? process.env.NOTIFY_SERVICE_URL;
  const token = configuration.appTokenProvider
    ? await configuration.appTokenProvider()
    : await (configuration.internalSecretProvider ?? getVaultInternalApiKey)();
  if (!url || !token) return null;
  return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

export async function send(params: {
  to: string;
  scope: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  urgency?: "low" | "normal" | "urgent";
}): Promise<void> {
  try {
    const target = await transport();
    if (!target) {
      log.warn({}, 'Notification skipped: service URL or credential provider unavailable');
      return;
    }
    const res = await fetch(`${target.url}/api/send`, {
      method: "POST",
      headers: target.headers,
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
  try {
    const target = await transport();
    if (!target) {
      log.warn({}, 'Broadcast skipped: service URL or credential provider unavailable');
      return;
    }
    const res = await fetch(`${target.url}/api/broadcast`, {
      method: "POST",
      headers: target.headers,
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
  try {
    const target = await transport();
    if (!target) return;
    const res = await fetch(`${target.url}/api/interest`, {
      method: "POST",
      headers: target.headers,
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

export const notify = { send, broadcast, interest, configure: configureNotify };
