/**
 * Permission system based on identity tiers and trust graph membership
 *
 * Tiers:
 * - none: unauthenticated
 * - soft: soft DID (session-based, no keypair)
 * - hard: hard DID (keypair-based)
 * - hard+graph: hard DID + at least one accepted connection in trust graph
 */

export type Action =
  | 'buy_ticket' | 'view_tickets' | 'event_lobby_chat'
  | 'edit_profile' | 'create_event'
  | 'dm' | 'pod_chat' | 'send_invite' | 'create_pod' | 'connections';

export type Tier = 'none' | 'soft' | 'hard' | 'hard+graph';

/**
 * Returns the minimum tier required for an action
 */
export function requiredTier(action: Action): Tier {
  switch (action) {
    // Anyone authenticated (soft or hard DID)
    case 'event_lobby_chat':
    case 'view_tickets':
    case 'buy_ticket':
      return 'soft';

    // Hard DID required
    case 'edit_profile':
    case 'create_event':
      return 'hard';

    // Hard DID + trust graph membership required
    case 'dm':
    case 'pod_chat':
    case 'send_invite':
    case 'create_pod':
    case 'connections':
      return 'hard+graph';

    default:
      return 'hard';
  }
}

/**
 * Checks if a user can perform an action based on their identity tier and graph membership
 *
 * @param did - The user's DID
 * @param action - The action they want to perform
 * @param currentTier - The user's current identity tier ('soft' | 'hard')
 * @param connectionsServiceUrl - URL of the connections service (optional, required for graph checks)
 * @returns Promise<boolean> - true if user can perform the action
 */
export async function canDo(
  did: string,
  action: Action,
  currentTier: 'soft' | 'hard',
  connectionsServiceUrl?: string
): Promise<boolean> {
  const required = requiredTier(action);

  // Check tier requirements
  if (required === 'none') {
    return true;
  }

  if (required === 'soft') {
    // Any authenticated user (soft or hard)
    return currentTier === 'soft' || currentTier === 'hard';
  }

  if (required === 'hard') {
    // Hard DID required
    return currentTier === 'hard';
  }

  if (required === 'hard+graph') {
    // Must be hard DID
    if (currentTier !== 'hard') {
      return false;
    }

    // Must be in trust graph (have at least one connection)
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
      console.error('Failed to check graph membership:', error);
      return false;
    }
  }

  return false;
}

/**
 * Checks if a user has the minimum tier required for an action
 * Does not check graph membership
 */
export function hasTier(currentTier: 'none' | 'soft' | 'hard', required: Tier): boolean {
  const tierLevels: Record<Tier, number> = {
    'none': 0,
    'soft': 1,
    'hard': 2,
    'hard+graph': 2, // tier check only, graph check is separate
  };

  return tierLevels[currentTier] >= tierLevels[required];
}
