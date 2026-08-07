import { requestDeviceCode } from '@/src/lib/github/connector';
import { signDeviceTicket } from '@/src/lib/github/device-ticket';
import { createDeviceStartHandler } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * POST /github/api/device/start — begin the GitHub device flow (#1391).
 *
 * Returns the `userCode` the human types at `verificationUri`, plus an opaque
 * `ticket` to hand back to /github/api/device/poll. No redirect URI and no
 * client secret are involved: the sealed config is `clientId` only.
 */
export const POST = createDeviceStartHandler({
  requestDeviceCode,
  signDeviceTicket,
  connectorName: 'github',
});
