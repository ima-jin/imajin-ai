/** Transport tests isolate the gate; run-access.test.ts exercises the real boundary. */
import type { ConnectionCaller } from '@/src/lib/kernel/connection-principal-policy';

export const assertRunAccess = async () => undefined;
export const canAccessRun = async () => true;
export const runCredentialCaller = (caller?: ConnectionCaller) => caller;
export const nodeRunCaller = () => ({ actorDid: 'did:imajin:node-witness' });
export const dispatchRunAttribution = async (did: string, caller?: ConnectionCaller) => ({
  actorDid: caller?.actorDid ?? did,
  ...(caller?.actingAs ? { orgDid: caller.actingAs } : {}),
});
export const readRunReceipt = async () => ({
  principalDid: 'did:imajin:veteze', actorDid: 'did:imajin:dispatch-actor', parentRunId: 'run-parent-1',
});
