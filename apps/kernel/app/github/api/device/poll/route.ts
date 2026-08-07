import { pollDeviceTokenOnce } from '@/src/lib/github/connector';
import { verifyDeviceTicket } from '@/src/lib/github/device-ticket';
import { createDevicePollHandler } from '@/src/lib/kernel/connector-oauth-routes';

/**
 * POST /github/api/device/poll — advance a GitHub device flow by one poll (#1391).
 *
 * Body: `{ ticket }` from /github/api/device/start.
 * Returns `{ status }` — one of authorized | pending | slow_down | expired |
 * denied. On `authorized` the token bundle is already sealed at
 * `github-oauth:${did}`; it is never returned to the client.
 */
export const POST = createDevicePollHandler({
  pollDeviceTokenOnce,
  verifyDeviceTicket,
  connectorName: 'github',
});
