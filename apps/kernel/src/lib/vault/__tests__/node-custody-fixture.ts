import { randomUUID } from 'node:crypto';
import type { NewVaultDelegationGrant } from '@/src/db/schemas/vault';

/** Synthetic crypto only; the custody pair matches sealAndStoreV2's real #1603 self-grant. */
export function nodeCustodyGrantFixture(field: string, nodeDid = 'did:imajin:node'): NewVaultDelegationGrant {
  return {
    id: randomUUID(), field, subject: nodeDid, grantedTo: nodeDid, status: 'active', oneTime: false,
    ownerXPub: 'fixture', wrappedKey: 'fixture', wrappedNonce: 'fixture', keyId: 'fixture', ownerSignature: 'fixture',
  };
}
