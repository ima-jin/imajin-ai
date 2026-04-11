/**
 * Permission system based on identity tiers and trust graph membership
 *
 * Tiers:
 * - none: unauthenticated
 * - soft: soft DID (session-based, no keypair)
 * - preliminary: keypair-based DID (registered, not yet established)
 * - established: established DID (keypair-based, fully onboarded)
 * - established+graph: established DID + at least one accepted connection in trust graph
 */

import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

export type Action =
  | 'buy_ticket' | 'view_tickets' | 'event_lobby_chat'
  | 'edit_profile' | 'create_event'
  | 'dm' | 'pod_chat' | 'send_invite' | 'create_pod' | 'connections';

export type Tier = 'none' | 'soft' | 'preliminary' | 'established' | 'established+graph';

/**
 * Returns the minimum tier required for an action
 */
export function requiredTier(action: Action): Tier {
  switch (action) {
    // Anyone authenticated (any DID)
    case 'event_lobby_chat':
    case 'view_tickets':
    case 'buy_ticket':
      return 'soft';

    // Preliminary DID required
    case 'edit_profile':
      return 'preliminary';

    // Established DID required
    case 'create_event':
    case 'send_invite':
      return 'established';

    // Established DID + trust graph membership required
    case 'dm':
    case 'pod_chat':
    case 'create_pod':
    case 'connections':
      return 'established+graph';

    default:
      return 'established';
  }
}

/**
 * Checks if a user can perform an action based on their identity tier and graph membership
 *
 * @param did - The user's DID
 * @param action - The action they want to perform
 * @param currentTier - The user's current identity tier
 * @param connectionsServiceUrl - URL of the connections service (optional, required for graph checks)
 * @returns Promise<boolean> - true if user can perform the action
 */
export async function canDo(
  did: string,
  action: Action,
  currentTier: 'soft' | 'preliminary' | 'established',
  connectionsServiceUrl?: string
): Promise<boolean> {
  const required = requiredTier(action);

  if (required === 'none') {
    return true;
  }

  if (required === 'soft') {
    return true; // any authenticated user
  }

  if (required === 'preliminary') {
    return currentTier === 'preliminary' || currentTier === 'established';
  }

  if (required === 'established') {
    return currentTier === 'established';
  }

  if (required === 'established+graph') {
    if (currentTier !== 'established') {
      return false;
    }

    if (!connectionsServiceUrl) {
      throw new Error('connectionsServiceUrl is required for graph membership checks');
    }

    try {
      const response = await fetch(`${connectionsServiceUrl}/api/connections/status/${encodeURIComponent(did)}`);
      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      return data.inGraph === true;
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to check graph membership');
      return false;
    }
  }

  return false;
}

/**
 * Checks if a user has the minimum tier required for an action
 * Does not check graph membership
 */
export function hasTier(currentTier: 'none' | 'soft' | 'preliminary' | 'established', required: Tier): boolean {
  const tierLevels: Record<string, number> = {
    'none': 0,
    'soft': 1,
    'preliminary': 2,
    'established': 3,
    'established+graph': 3, // tier check only, graph check is separate
  };

  return (tierLevels[currentTier] ?? 0) >= (tierLevels[required] ?? 0);
}
