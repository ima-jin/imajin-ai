/**
 * Signed device-flow tickets for the GitHub connect flow (#1391).
 * Thin wrapper around the shared connector-device-ticket factory.
 */
import { createDeviceTicketHelpers } from '../kernel/connector-device-ticket';

export const { signDeviceTicket, verifyDeviceTicket } = createDeviceTicketHelpers('github_device');
