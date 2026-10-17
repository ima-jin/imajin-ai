/** Node-selected policy; replacement policies do not replace lifecycle safety checks. */
export const OWNERSHIP_POLICY_KEY = 'identity.ownership.policy';
export const PENDING_OWNER_TRANSFER_KEY = 'pending-owner-transfer';

export interface PendingOwnerTransfer {
  id: string;
  from: string;
  to: string;
  by: string;
  policy: string;
  createdAt: string;
}

export interface OwnershipPolicyContext {
  action: 'propose' | 'cancel' | 'accept';
  groupDid: string;
  actorDid: string;
  ownerDid: string;
  pendingTransfer: PendingOwnerTransfer | null;
}

export type OwnershipPolicy = (context: OwnershipPolicyContext) => boolean | Promise<boolean>;
export type OwnershipPolicyRegistry = Readonly<Record<string, OwnershipPolicy>>;

export const ownershipPolicies: OwnershipPolicyRegistry = {
  'owner-only': ({ action, actorDid, ownerDid, pendingTransfer }) =>
    action === 'accept'
      ? pendingTransfer?.to === actorDid && pendingTransfer.from === ownerDid
      : actorDid === ownerDid,
};

export class OwnershipError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

export function resolveOwnershipPolicy(value: unknown, registry = ownershipPolicies) {
  const id = value === undefined ? 'owner-only' : value;
  if (typeof id !== 'string' || !Object.hasOwn(registry, id)) {
    throw new OwnershipError('Unknown ownership policy', 403, 'OWNERSHIP_POLICY_UNKNOWN');
  }
  return { id, allows: registry[id] };
}

export function identityMetadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Fail closed on malformed server-owned state rather than treating it as a new invitation. */
export function readPendingTransfer(metadata: unknown): PendingOwnerTransfer | null {
  const value = identityMetadata(metadata)[PENDING_OWNER_TRANSFER_KEY];
  if (value === undefined) return null;
  const record = identityMetadata(value);
  const fields = ['id', 'from', 'to', 'by', 'policy', 'createdAt'] as const;
  if (!fields.every((key) => typeof record[key] === 'string' && record[key] !== '')) {
    throw new OwnershipError('Invalid pending ownership transfer', 409);
  }
  return record as unknown as PendingOwnerTransfer;
}
