/**
 * Scope vocabulary for delegated app sessions (Issue #244)
 *
 * Each scope maps to a human-readable label shown on the consent screen.
 */
export const SCOPES = {
  'profile:read':       'Read your profile information',
  'identity:read':      'Read your identity and DID',
  'wallet:read':        'View your wallet balance and transaction history',
  'wallet:write':       'Create payments and transfers on your behalf',
  'connections:read':   'View your connections',
  'events:read':        'View events you attend or have created',
  'events:write':       'Create and manage events on your behalf',
  'messages:read':      'Read messages in your conversations',
  'messages:write':     'Send messages on your behalf',
  'attestations:read':  'View your attestations and reputation',
  'attestations:write': 'Issue attestations on your behalf',
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
