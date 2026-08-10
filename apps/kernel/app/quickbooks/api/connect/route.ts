import { buildAuthorizeUrl } from '@/src/lib/quickbooks/connector';
import { signState } from '@/src/lib/quickbooks/oauth-state';
import { createConnectHandler, resolveConfigDidWithPlatformFallback } from '@/src/lib/kernel/connector-oauth-routes';

/** Must match `configPrefix: 'quickbooks-config'` in `src/lib/quickbooks/connector.ts`. */
const QUICKBOOKS_CONFIG_PREFIX = 'quickbooks-config';

/**
 * GET /quickbooks/api/connect — begin the Intuit OAuth2 authorization-code
 * flow.
 *
 * QuickBooks uses a two-tier credential model (#1775): the Intuit developer
 * app (client_id + client_secret) is registered once against a platform/org
 * identity and shared by every connecting user — individual users only ever
 * own their own resulting tokens, never an app registration of their own.
 * `resolveConfigDidWithPlatformFallback` resolves the DID whose sealed config
 * backs this flow, in order:
 *   1. App-auth headers (#1704) — the delegating app's own sealed config,
 *      walking to its registrant DID when nothing is sealed at the app DID
 *      directly (#1770).
 *   2. The session owner's own sealed config (BYO-app, unchanged).
 *   3. The shared `PLATFORM_DID` config (#1775) — what makes a plain
 *      "Connect QuickBooks" click from the kernel's own UI work for any user,
 *      not just whichever DID happens to have configured the Intuit app.
 */
export const GET = createConnectHandler(
  buildAuthorizeUrl,
  signState,
  (request, ownerDid) => resolveConfigDidWithPlatformFallback(request, ownerDid, QUICKBOOKS_CONFIG_PREFIX),
);
