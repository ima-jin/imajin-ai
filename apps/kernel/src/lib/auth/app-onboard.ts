import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { buildPublicUrlAbsolute, rateLimit } from '@imajin/config';
import { db, attestations, credentials, registryApps, transactions } from '@/src/db';
import { verifyAppServiceToken } from './jwt';
import { hasAppAuthorizationGrant } from './app-authorization-grant';
import { prepareMechanicalAttestation } from './emit-mechanical-attestation';
import { deliverOnboardEmail } from './onboard-delivery';
import { retrieveByoCheckoutCustomer } from '@/src/lib/stripe/byo-checkout';

export const ONBOARD_SEND_SCOPE = 'onboard:send';
export const onboardSendBody = z.object({ transactionId: z.string().trim().min(1).max(200) }).strict();
type Refusal = { error: string; status: number; retryAfter?: number };
type App = { appDid: string; ownerDid: string; name: string };

/** Strict existing verifier plus live registry and operator approval, not static app headers. */
export async function authenticateOnboardApp(request: Request): Promise<App | Refusal> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return { error: 'App-service token required', status: 401 };
  const caller = await verifyAppServiceToken(header.slice(7));
  if (!caller) return { error: 'Invalid app-service token', status: 401 };
  if (!caller.scopes.includes(ONBOARD_SEND_SCOPE)) return { error: 'Scope not granted', status: 403 };
  const [app] = await db.select({
    appDid: registryApps.appDid, ownerDid: registryApps.ownerDid, name: registryApps.name,
    status: registryApps.status, approved: registryApps.approvedServiceScopes,
  }).from(registryApps).where(eq(registryApps.appDid, caller.appDid)).limit(1);
  if (app?.status !== 'active' || !app.approved?.includes(ONBOARD_SEND_SCOPE)) {
    return { error: 'Active registration and operator approval required', status: 403 };
  }
  return { appDid: caller.appDid, ownerDid: app.ownerDid, name: app.name };
}

const unavailable = (): Refusal => ({ error: 'Order unavailable', status: 404 });

/** No global contact lookup until both app binding and resource-owner authority hold. */
async function loadOrder(app: App, transactionId: string) {
  const [order] = await db.select().from(transactions).where(and(
    eq(transactions.id, transactionId), eq(transactions.appDid, app.appDid),
    eq(transactions.status, 'completed'), eq(transactions.rail, 'stripe-byo'),
  )).limit(1);
  if (order?.appDid !== app.appDid || order.status !== 'completed'
    || order.rail !== 'stripe-byo' || !order.externalRef?.startsWith('cs_')) return null;
  if (order.toDid !== app.ownerDid
    && !await hasAppAuthorizationGrant(app.appDid, order.toDid, ONBOARD_SEND_SCOPE)) return null;
  return order;
}

async function buyerContact(order: typeof transactions.$inferSelect): Promise<string | null> {
  if (order.fromDid) {
    // An established buyer must use their verified kernel credential; never a billing-address fallback.
    const [credential] = await db.select({ email: credentials.value }).from(credentials).where(and(
      eq(credentials.did, order.fromDid), eq(credentials.type, 'email'), isNotNull(credentials.verifiedAt),
    )).limit(1);
    return credential?.email ?? null;
  }
  // Anonymous checkout: recover the customer from the recorded seller's rail, not request/metadata.
  const customer = await retrieveByoCheckoutCustomer(order.toDid, order.externalRef!);
  return customer.email;
}

function throttle(key: string, limit: number, window: number): Refusal | null {
  const result = rateLimit(key, limit, window);
  return result.limited
    ? { error: 'Too many requests', status: 429, retryAfter: result.retryAfter }
    : null;
}

/** Send the ordinary verification email; no bearer, poll handle, email or redirect is returned. */
export async function sendOrderOnboard(app: App, transactionId: string): Promise<{ status: 'sent' } | Refusal> {
  const appLimit = throttle(`onboard-app:${app.appDid}`, 20, 60_000);
  if (appLimit) return appLimit;
  const order = await loadOrder(app, transactionId);
  if (!order) return unavailable();
  const orderLimit = throttle(`onboard-order:${app.appDid}:${order.id}`, 3, 3_600_000);
  if (orderLimit) return orderLimit;
  const email = await buyerContact(order);
  const parsedEmail = z.string().trim().toLowerCase().email().safeParse(email);
  if (!parsedEmail.success) return unavailable();
  const emailLimit = throttle(`onboard-email:${parsedEmail.data}`, 3, 3_600_000);
  if (emailLimit) return emailLimit;

  // Durable intent survives a crash or a failed final audit write without falsely claiming delivery.
  const intent = await prepareMechanicalAttestation({
    subjectDid: app.appDid, type: 'onboard.link.requested', contextId: order.id, contextType: 'order',
    payload: { onBehalfOf: app.appDid, ownerDid: order.toDid, transactionId: order.id, delivery: 'email' },
  });
  await db.insert(attestations).values(intent);
  const record = await prepareMechanicalAttestation({
    subjectDid: app.appDid, type: 'onboard.link.sent', contextId: order.id, contextType: 'order',
    payload: {
      onBehalfOf: app.appDid, ownerDid: order.toDid, transactionId: order.id,
      delivery: 'email', requestId: intent.id,
    },
  });
  const delivery = await deliverOnboardEmail({
    email: parsedEmail.data, redirectUrl: buildPublicUrlAbsolute('auth'),
    context: 'access your order', onBehalfOf: app.name,
  });
  if (!delivery.success) return { error: 'Email delivery failed', status: 502 };
  // Await durability; a failed write must not be reported to the caller as an audited success.
  await db.insert(attestations).values(record);
  return { status: 'sent' };
}
