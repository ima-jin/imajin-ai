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

export type ConversationDidType = 'dm' | 'group' | 'event' | 'identity' | 'unknown';

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
    // No colon after did:imajin: — this is an identity DID used as a conversation
    // (e.g. event conversations use the event's identity DID directly)
    return { type: 'identity', slug: rest };
  }

  const type = rest.slice(0, colonIdx) as ConversationDidType;
  const slug = rest.slice(colonIdx + 1) || undefined;

  const knownTypes: ConversationDidType[] = ['dm', 'group', 'event'];
  if (!knownTypes.includes(type)) {
    // Unknown type prefix — treat as identity DID
    return { type: 'identity', slug: rest };
  }

  return { type, slug };
}

/**
 * Converts a conversation DID to a URL path segment.
 * did:imajin:group:abc123 → 'group/abc123'
 * did:imajin:dm:def456 → 'dm/def456'
 * did:imajin:evt_foo → 'evt_foo' (legacy, single segment)
 */
export function conversationPath(did: string): string {
  const parsed = parseConversationDid(did);
  if (parsed.type === 'unknown') return encodeURIComponent(did);
  if (parsed.type === 'event' && !parsed.slug) return did.slice('did:imajin:'.length);
  // Identity DIDs (e.g. event conversations using did:imajin:Base58Key)
  // Route as identity/slug so the page can reconstruct did:imajin:slug
  if (parsed.type === ('identity')) return `identity/${parsed.slug}`;
  return `${parsed.type}/${parsed.slug}`;
}
