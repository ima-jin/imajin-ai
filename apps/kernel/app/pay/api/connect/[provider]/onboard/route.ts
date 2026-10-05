/**
 * POST /api/connect/{provider}/onboard — rail-generic alias of the
 * Stripe-named `POST /api/connect/onboard` (#2177). Dispatches on
 * `{provider}` to the same handler; adds `provider` to the response.
 */
import { POST as stripePost } from '../../onboard/route';
import { railAliasOptions, railAliasRoute, annotateConnectProvider } from '@/src/lib/pay/rail-alias';

export const OPTIONS = railAliasOptions;
export const POST = railAliasRoute({ stripe: stripePost }, annotateConnectProvider);
