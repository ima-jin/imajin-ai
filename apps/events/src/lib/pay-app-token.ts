/**
 * Events' own app-service token for the pay service (#2739).
 *
 * Events is a registered app. It authenticates checkout, settlement, refunds
 * and campaign pledge calls as ITSELF with an app-service token minted from
 * the kernel by proving possession of its own signing key — never a shared key.
 *
 * The signing key is read through the standard `loadAppSigningKey` claim-code
 * path (`IMAJIN_APP_CLAIM_CODE` on first boot, the local bootstrap keystore on
 * every later boot) and kept in memory only. This module does not mint or
 * invent an app DID or key: when events is not registered/provisioned yet,
 * `loadAppSigningKey` throws and the callers fail closed.
 *
 * Operator prerequisites (see apps/events/README.md):
 *   - events registered as an app, signing key provisioned (`apps.provision`);
 *   - `pay:settle`, `pay:refund` and `pay:charge-pledges` approved for events
 *     via the `apps:service-scopes` card.
 */
import { createAppServiceTokenProvider, loadAppSigningKey, type AppServiceTokenProvider } from '@imajin/auth-client';

// Held on `globalThis` (not a module-level `let`): Next can bundle this module into more than one
// route chunk of the same server process, and a one-time claim code can only be redeemed once — a
// second copy that tried to load the key again would fail on a spent code.
const PROVIDER_KEY = Symbol.for('@imajin/events:pay-app-token-provider');
type ProviderHolder = { [PROVIDER_KEY]?: Promise<AppServiceTokenProvider> | null };

function holder(): ProviderHolder {
  return globalThis as ProviderHolder;
}

async function createProvider(): Promise<AppServiceTokenProvider> {
  const kernelUrl = process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) {
    throw new Error('events pay app token: IMAJIN_KERNEL_URL is not set');
  }
  const signingKey = await loadAppSigningKey({ kernelUrl, hostHint: 'events' });
  return createAppServiceTokenProvider({ kernelUrl, appDid: signingKey.appDid, privateKey: signingKey.privateKey });
}

function getProvider(): Promise<AppServiceTokenProvider> {
  const h = holder();
  const existing = h[PROVIDER_KEY];
  if (existing) return existing;

  const created = createProvider().catch((err: unknown) => {
    // Don't cache a failed load — the next call retries (e.g. once the operator has provisioned the app).
    h[PROVIDER_KEY] = null;
    throw err;
  });
  h[PROVIDER_KEY] = created;
  return created;
}

/** Events' current app-service token (minted/refreshed as needed). Throws when it cannot be obtained. */
export async function getPayAppToken(): Promise<string> {
  return (await getProvider()).getToken();
}

/** Drop the cached token — call after the pay service answered 401 so the next call mints a fresh one. */
export async function invalidatePayAppToken(): Promise<void> {
  (await getProvider()).invalidate();
}
/** POST as events; retry only a 401, once, with a freshly minted token (#2741). */
export async function postPayAsApp(path: string, body: unknown, cookie?: string): Promise<Response> {
  const payServiceUrl = process.env.PAY_SERVICE_URL;
  if (!payServiceUrl) throw new Error('PAY_SERVICE_URL is not set');
  const serializedBody = JSON.stringify(body);
  const send = async () => fetch(`${payServiceUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getPayAppToken()}`,
      ...(cookie !== undefined && { Cookie: cookie }),
    },
    body: serializedBody,
  });
  const response = await send();
  if (response.status !== 401) return response;
  await invalidatePayAppToken().catch(() => undefined);
  return send();
}

/** Forget the cached provider (tests only). */
export function resetPayAppTokenForTests(): void {
  holder()[PROVIDER_KEY] = null;
}
