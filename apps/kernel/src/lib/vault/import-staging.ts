/**
 * Import uses the existing sealed operator-input namespace, single-use claim,
 * and hourly expiry sweep. No plaintext belongs in the approval record.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import {
  stageAppSecret, consumeAppSecret, discardAppSecretForProposal,
} from '@/src/lib/apps/secret-staging';
import { appSecretsKind } from '@/src/lib/apps/secrets-kind';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';

export interface ImportDetail {
  [key: string]: unknown;
  ownerDid: string;
  consumerDid: string;
  purpose: string;
  fingerprint: string;
  label: string | null;
  expiresAt: string | null;
  replacesField: string | null;
}

export function importFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function binding(proposalId: string, operatorDid: string, detail: ImportDetail) {
  // A domain-separated hash binds every displayed and executed metadata field.
  const name = createHash('sha256').update(`vault:import\n${canonicalize(detail)}`).digest('hex');
  return {
    proposalId, operatorDid, appDid: detail.ownerDid, name,
    action: detail.replacesField ? 'rotate' as const : 'set' as const,
  };
}

export function stageImport(proposalId: string, operatorDid: string, detail: ImportDetail, value: string): Promise<string> {
  return stageAppSecret(binding(proposalId, operatorDid, detail), value);
}

export async function consumeImport(card: OperatorApprovalCard, detail: ImportDetail): Promise<string> {
  if (typeof card.detail?.stagingRef !== 'string') throw new Error('Import staging unavailable');
  const value = await consumeAppSecret(card.detail.stagingRef, binding(card.proposalId, card.operatorDid, detail));
  if (importFingerprint(value) !== detail.fingerprint) throw new Error('Import staging unavailable');
  return value;
}

/** Adapt only the lifecycle binding; the existing cleaner verifies it against the sealed bytes. */
export async function discardImportForProposal(card: Pick<OperatorApprovalCard,
  'proposalId' | 'operatorDid' | 'source' | 'kind' | 'detail' | 'status'>): Promise<void> {
  if (card.source !== 'vault' || card.kind !== 'vault:import' || !card.detail) return;
  const { stagingRef, ...detail } = card.detail;
  const staged = binding(card.proposalId, card.operatorDid, detail as ImportDetail);
  await discardAppSecretForProposal({
    ...card, source: 'apps', kind: appSecretsKind(staged.action),
    detail: { appDid: staged.appDid, name: staged.name, stagingRef },
  });
}
