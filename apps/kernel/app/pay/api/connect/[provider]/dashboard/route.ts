/**
 * GET /api/connect/{provider}/dashboard — rail-generic alias of the
 * Stripe-named `GET /api/connect/dashboard` (#2177). Dispatches on
 * `{provider}` to the same handler; the response is unchanged.
 */
import { GET as stripeGet } from '../../dashboard/route';
import { railAliasRoute } from '@/src/lib/pay/rail-alias';

export { railAliasOptions as OPTIONS } from '@/src/lib/pay/rail-alias';
export const GET = railAliasRoute({ stripe: stripeGet });
