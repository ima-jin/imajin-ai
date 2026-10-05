/**
 * GET /api/connect/{provider}/status — rail-generic alias of the
 * Stripe-named `GET /api/connect/status` (#2177). Dispatches on
 * `{provider}` to the same handler; adds `provider` and the rail-neutral
 * `accountId` to the response (the original `stripeAccountId` is kept).
 */
import { GET as stripeGet } from '../../status/route';
import { railAliasRoute, annotateConnectStatus } from '@/src/lib/pay/rail-alias';

export { railAliasOptions as OPTIONS } from '@/src/lib/pay/rail-alias';
export const GET = railAliasRoute({ stripe: stripeGet }, annotateConnectStatus);
