/**
 * POST /api/webhook/{provider} — rail-generic alias of the Stripe-named
 * `POST /api/webhook` (#2177). Dispatches on `{provider}` to the same
 * handler (which verifies the rail's own signature); the response is
 * unchanged. Webhook convergence onto the bus (#2175 / #1785) is a
 * separate change — this only adds the rail-generic path.
 */
import { POST as stripePost } from '../route';
import { railAliasRoute } from '@/src/lib/pay/rail-alias';

export const POST = railAliasRoute({ stripe: stripePost });
