import { createHash } from 'node:crypto';
import type { FairManifestV11 } from '@imajin/fair';
import { parseLegalEntity } from '../profile/legal-entity-document';

export { isLegalEntityAsset } from './control-document-kind';

/** Durable proof of each state change without copying any legal fields. */
export async function prepareLegalEntityChange(
  assetId: string, ownerDid: string, composedBy: string,
  content: string, previousHash: string | null,
) {
  const { input } = parseLegalEntity(content, ownerDid);
  const { prepareMechanicalAttestation } = await import('../auth/emit-mechanical-attestation');
  return prepareMechanicalAttestation({
    subjectDid: ownerDid,
    type: previousHash ? 'document.amended' : 'document.created',
    contextId: assetId,
    contextType: 'legal-entity',
    payload: {
      schema: 'legal-entity:v1', composedBy,
      operation: input ? 'save' : 'revoke',
      contentHash: createHash('sha256').update(content).digest('hex'),
      previousHash,
    },
  });
}

/** Fail closed BEFORE writing bytes; the signature binds values, policy, actor and deletion. */
export async function signLegalEntityDocument(
  manifest: FairManifestV11,
  content: string,
  ownerDid: string,
  composedBy: string,
): Promise<FairManifestV11> {
  const parsed = parseLegalEntity(content, ownerDid);
  const { contentSigner } = await import('./content-signer');
  return contentSigner.sign({
    ...manifest,
    access: { type: 'private' },
    integrity: {
      hash: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content, 'utf8'),
    },
    intent: {
      purpose: 'legal-entity',
      constraints: { composedBy, revoked: parsed.input === null },
    },
  });
}
