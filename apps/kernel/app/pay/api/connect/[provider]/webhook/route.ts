/**
 * POST /api/connect/{provider}/webhook — rail-generic alias of the
 * Stripe-named `POST /api/connect/webhook` (#2177). Dispatches on
 * `{provider}` to the same handler (which verifies the rail's own
 * signature); the response is unchanged.
 */
import { POST as stripePost } from '../../webhook/route';
import { railAliasRoute } from '@/src/lib/pay/rail-alias';

export const POST = railAliasRoute({ stripe: stripePost });
