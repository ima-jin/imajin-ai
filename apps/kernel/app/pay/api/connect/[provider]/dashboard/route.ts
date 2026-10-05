/**
 * GET /api/connect/{provider}/dashboard — rail-generic alias of the
 * Stripe-named `GET /api/connect/dashboard` (#2177). Dispatches on
 * `{provider}` to the same handler; the response is unchanged.
 */
import { GET as stripeGet } from '../../dashboard/route';
import { railAliasOptions, railAliasRoute } from '@/src/lib/pay/rail-alias';

export const OPTIONS = railAliasOptions;
export const GET = railAliasRoute({ stripe: stripeGet });
