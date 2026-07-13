/**
 * Scope vocabulary for delegated app sessions (Issue #244)
 *
 * Each scope maps to a human-readable label shown on the consent screen.
 */
export const SCOPES = {
  'profile:read':       'Read your profile information',
  'identity:read':      'Read your identity and DID',
  'media:read':         'Read your media library (files, folders, and metadata)',
  'media:write':        'Create and upload media on your behalf',
  'media:share':        'Share your media with other people',
  'wallet:read':        'View your wallet balance and transaction history',
  'wallet:write':       'Create payments and transfers on your behalf',
  'connections:read':   'View your connections',
  'events:read':        'View events you attend or have created',
  'events:write':       'Create and manage events on your behalf',
  'supply:read':        'View your supply-chain lots and their stage history',
  'supply:write':       'Record supply-chain stages (declare, collect, process, list) on your behalf',
  'messages:read':      'Read messages in your conversations',
  'messages:write':     'Send messages on your behalf',
  'attestations:read':  'View your attestations and reputation',
  'attestations:write': 'Issue attestations on your behalf',
  'availability:read':  'View your availability and coordination intents',
  'availability:write': 'Set and cancel availability intents on your behalf',
  'quickbooks:read':    'Read your QuickBooks invoices as supply-chain settlement signals',
  'quickbooks:write':   'Create QuickBooks invoices on your behalf (supply-chain settlement)',
  'github:read':        'Read your repos, issues and PRs on GitHub',
  'github:write':       'Open and comment on issues & PRs on your GitHub repos',
  'github:org':         'Act on repos owned by an org or other people on GitHub',
  'github:actions':     'Trigger GitHub Actions / deploy / spend CI minutes',
  'discord:post':       'Post messages to Discord channels on your behalf',
  'discord:read':       'Read messages from Discord channels on your behalf',
} as const;

export type Scope = keyof typeof SCOPES;

export function validateScopes(scopes: string[]): { valid: Scope[]; invalid: string[] } {
  const valid: Scope[] = [];
  const invalid: string[] = [];
  for (const s of scopes) {
    if (s in SCOPES) valid.push(s as Scope);
    else invalid.push(s);
  }
  return { valid, invalid };
}
