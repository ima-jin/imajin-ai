/**
 * Signed, stateless device-flow tickets for connector device authorization (#1391).
 *
 * RFC 8628 splits the connect step in two: the server asks the provider for a
 * `device_code`, then polls with it until the human finishes authorizing at the
 * provider's verification page. Those are separate HTTP requests from the
 * browser, so the `device_code` has to survive between them.
 *
 * A ticket is that carrier: `{ did, deviceCode }` HMAC-signed with a 15-minute
 * TTL (device codes themselves expire in about that long). Choosing a signed
 * ticket over a server-side pending-device table or an extra sealed vault field
 * keeps the poll route stateless, and the DID inside it is what makes the
 * ticket useless to anyone else — the poll route requires a session and rejects
 * any ticket whose DID is not the caller's. So a leaked ticket cannot be
 * redeemed by the leaker, and a caller cannot poll for someone else's flow by
 * forging one.
 *
 * Usage:
 *   const { signDeviceTicket, verifyDeviceTicket } = createDeviceTicketHelpers('github_device');
 */
import { createSignedPayloadCodec } from './connector-signed-payload';

/**
 * Ticket lifetime. Slightly longer than GitHub's 900s device-code expiry so the
 * provider — not us — is the one that reports the code as expired, which gives
 * the user the accurate error instead of a generic "ticket expired".
 */
const DEVICE_TICKET_TTL_MS = 16 * 60 * 1000;

interface DeviceTicketPayload {
  /** Owner DID the device flow was started for. */
  did: string;
  /** The provider's `device_code` for this pending authorization. */
  deviceCode: string;
}

/** Result of a successful {@link DeviceTicketHelpers.verifyDeviceTicket}. */
export interface VerifiedDeviceTicket {
  did: string;
  deviceCode: string;
}

export interface DeviceTicketHelpers {
  /** Mint a ticket binding `ownerDid` to a pending `deviceCode`. */
  signDeviceTicket(ownerDid: string, deviceCode: string): string;
  /** Verify a ticket's signature + TTL. Throws on tamper/expiry. */
  verifyDeviceTicket(ticket: string): VerifiedDeviceTicket;
}

/**
 * Create a sign/verify pair scoped to one connector, e.g. `'github_device'`.
 * Uses `AUTH_PRIVATE_KEY` as the HMAC secret, like every other connector
 * signature in the kernel.
 */
export function createDeviceTicketHelpers(errorPrefix: string): DeviceTicketHelpers {
  const codec = createSignedPayloadCodec<DeviceTicketPayload>(errorPrefix, DEVICE_TICKET_TTL_MS);

  return {
    signDeviceTicket: (ownerDid, deviceCode) => codec.sign({ did: ownerDid, deviceCode }),
    verifyDeviceTicket: (ticket) => {
      const payload = codec.verify(ticket);
      return { did: payload.did, deviceCode: payload.deviceCode };
    },
  };
}
