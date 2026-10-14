import { and, eq } from 'drizzle-orm';

export interface KernelWebhookRecipient {
  appDid?: string;
  appSlug?: string;
}
function validateRecipient(recipient: KernelWebhookRecipient): void {
  if (!recipient || (!recipient.appDid && !recipient.appSlug)) throw new Error('Kernel webhook recipient is required');
  if (recipient.appDid !== undefined) validateKernelWebhookAudience(recipient.appDid);
  if (recipient.appSlug !== undefined &&
      (typeof recipient.appSlug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(recipient.appSlug))) {
    throw new Error('Kernel webhook recipient slug is invalid');
  }
}

export function validateKernelWebhookAudience(audience: string): void {
  if (typeof audience !== 'string' || !/^did:imajin:[A-Za-z0-9_-]+$/.test(audience)) {
    throw new Error('Kernel webhook audience must be an app DID');
  }
}

function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid kernel webhook destination');
  }
  return url.origin;
}
function registeredOrigin(value: string): string | null {
  try {
    return origin(value);
  } catch {
    // Navigation entryUrl can be relative; legacy redirect hosts may be bare slugs.
    // Neither grants an origin or blocks an otherwise valid absolute registration.
    return null;
  }
}

const KERNEL_SERVICE_URLS = new Map([
  ['coffee', 'COFFEE_SERVICE_URL'],
  ['events', 'EVENTS_SERVICE_URL'],
  ['learn', 'LEARN_SERVICE_URL'],
  ['market', 'MARKET_SERVICE_URL'],
]);

/** Resolve only trusted configuration, never an event payload or inbound header. */
export async function resolveKernelWebhookAudience(
  url: string,
  recipient: KernelWebhookRecipient,
): Promise<string> {
  validateRecipient(recipient);
  const { db, registryApps } = await import('@/src/db');
  const conditions = [eq(registryApps.status, 'active')];
  if (recipient.appDid) conditions.push(eq(registryApps.appDid, recipient.appDid));
  if (recipient.appSlug) conditions.push(eq(registryApps.slug, recipient.appSlug));
  const [app] = await db.select().from(registryApps).where(and(...conditions)).limit(1);
  if (app?.status !== 'active') throw new Error('Kernel webhook recipient is not registered and active');
  validateKernelWebhookAudience(app.appDid);

  const registered = [
    ...(app.allowedRedirectHosts ?? []), ...(app.redirectUris ?? []),
    app.callbackUrl, app.homepageUrl, app.entryUrl,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  // Known kernel-routed services may be provisioned as third_party and reached internally.
  // Only these fixed operator-owned settings grant an additional origin, never arbitrary slugs.
  const serviceSetting = KERNEL_SERVICE_URLS.get(app.slug ?? '');
  const serviceUrl = serviceSetting ? process.env[serviceSetting] : undefined;
  if (serviceUrl) registered.push(serviceUrl);
  const destination = origin(url);
  if (!registered.some((value) => registeredOrigin(value) === destination)) {
    throw new Error('Kernel webhook destination does not match its registered recipient');
  }
  return app.appDid;
}
