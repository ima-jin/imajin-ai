/**
 * Test support for the turn-evidence lib (#1978): real Ed25519 keys and real
 * signatures over the real signing message, so the tests exercise the same
 * cryptographic path production does rather than a stubbed verifier.
 */
import { crypto as authCrypto, buildTurnEvidencePayload, hashToolIo, turnEvidenceSigningMessage } from '@imajin/auth';
import type { TurnEvidenceFields, TurnEvidencePayload } from '@imajin/auth';
import type { TurnEvidenceBatch, TurnEvidenceItem } from '../types';

export const AGENT_DID = 'did:imajin:agent-jin';
export const PRINCIPAL_DID = 'did:imajin:principal-ryan';
export const TURN_EVENT_ID = 'turn_evt_0001';
export const CLAIM_TEXT = 'The contract at 0xabc is live on Sepolia.';
export const CLAIM_HASH = hashToolIo(CLAIM_TEXT);
export const USAGE_ID = 'att_usage0001';

export const AGENT_KEYPAIR = authCrypto.generateKeypair();
export const OTHER_KEYPAIR = authCrypto.generateKeypair();

export const ISSUED_AT = Date.now() - 1_000;

export function evidenceFields(seq: number, overrides: Partial<TurnEvidenceFields> = {}): TurnEvidenceFields {
  return {
    turnEventId: TURN_EVENT_ID,
    turnOutputHash: CLAIM_HASH,
    agentDid: AGENT_DID,
    principalDid: PRINCIPAL_DID,
    tool: { name: seq % 2 === 0 ? 'web_fetch' : 'eth_getCode', provider: 'openclaw' },
    inputHash: hashToolIo({ call: seq, args: { address: '0xabc' } }),
    outputHash: hashToolIo(`output-${seq}`),
    observedAt: '2026-09-04T03:54:12Z',
    seq,
    ...overrides,
  };
}

export function signItem(
  payload: TurnEvidencePayload,
  privateKey: string = AGENT_KEYPAIR.privateKey,
  issuedAt: number = ISSUED_AT,
): TurnEvidenceItem {
  return {
    payload,
    issuedAt,
    signature: authCrypto.signSync(turnEvidenceSigningMessage(payload, issuedAt), privateKey),
  };
}

export function signedItem(seq: number, overrides: Partial<TurnEvidenceFields> = {}): TurnEvidenceItem {
  return signItem(buildTurnEvidencePayload(evidenceFields(seq, overrides)));
}

export function batchOf(items: TurnEvidenceItem[]): TurnEvidenceBatch {
  const { turnEventId, turnOutputHash, agentDid, principalDid } = items[0].payload;
  return { turnEventId, turnOutputHash, agentDid, principalDid, items };
}

/** The wire body `POST /auth/api/attestations/turn-evidence` accepts for `items`. */
export function wireBody(items: TurnEvidenceItem[]) {
  return {
    evidence: items.map((item) => ({ payload: item.payload, issued_at: item.issuedAt, signature: item.signature })),
  };
}
