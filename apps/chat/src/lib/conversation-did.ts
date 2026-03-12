import { createHash } from 'crypto';

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Derives a stable DID for a direct message conversation between two parties.
 * Sorting ensures the same DID regardless of argument order.
 */
export function dmDid(did1: string, did2: string): string {
  const sorted = [did1, did2].sort();
  const hash = sha256hex(sorted.join(':')).slice(0, 16);
  return `did:imajin:dm:${hash}`;
}

/**
 * Derives a stable DID for a group conversation given its member DIDs.
 * Sorting ensures the same DID regardless of member order.
 */
export function groupDid(members: string[]): string {
  const sorted = [...members].sort();
  const hash = sha256hex(sorted.join(':')).slice(0, 16);
  return `did:imajin:group:${hash}`;
}

export type ConversationDidType = 'dm' | 'group' | 'event' | 'unknown';

export interface ParsedConversationDid {
  type: ConversationDidType;
  slug?: string;
}

/**
 * Parses a conversation DID into its type and optional slug.
 * Examples:
 *   did:imajin:dm:abc123      → { type: 'dm', slug: 'abc123' }
 *   did:imajin:group:xyz789   → { type: 'group', slug: 'xyz789' }
 *   did:imajin:event:evt_foo  → { type: 'event', slug: 'evt_foo' }
 */
export function parseConversationDid(did: string): ParsedConversationDid {
  const prefix = 'did:imajin:';
  if (!did.startsWith(prefix)) {
    return { type: 'unknown' };
  }

  const rest = did.slice(prefix.length);

  // Handle legacy event DID format: did:imajin:evt_xxx (no colon type separator)
  if (rest.startsWith('evt_')) {
    return { type: 'event', slug: rest };
  }

  const colonIdx = rest.indexOf(':');

  if (colonIdx === -1) {
    return { type: 'unknown' };
  }

  const type = rest.slice(0, colonIdx) as ConversationDidType;
  const slug = rest.slice(colonIdx + 1) || undefined;

  const knownTypes: ConversationDidType[] = ['dm', 'group', 'event'];
  if (!knownTypes.includes(type)) {
    return { type: 'unknown', slug };
  }

  return { type, slug };
}
