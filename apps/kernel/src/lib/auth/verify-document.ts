import { createHash } from 'node:crypto';
import { verifyDocumentSignatureToken } from './document-signatures';

interface DocumentProof {
  issuerDid: string;
  documentHash: string | null;
  totalSigners: number | null;
  revokedAt: Date | null;
}

interface SignerProof {
  signerDid: string;
  status: string;
  jws: string | null;
}

/** Verify the bytes supplied by the party, not a client-declared hash. */
export async function verifyDocumentFile(
  file: Uint8Array,
  document: DocumentProof,
  signatures: SignerProof[],
  publicKeys: Map<string, string>,
) {
  const hash = createHash('sha256').update(file).digest('hex');
  const hashMatches = hash === document.documentHash;
  const uniqueSigners = new Set(signatures.map((signature) => signature.signerDid));
  const complete = signatures.length >= 2
    && signatures.length === document.totalSigners
    && uniqueSigners.size === signatures.length
    && uniqueSigners.has(document.issuerDid);
  const checks = await Promise.all(signatures.map(async (signature) => {
    const key = publicKeys.get(signature.signerDid);
    if (signature.status !== 'signed' || !signature.jws || !key || !document.documentHash) return false;
    return verifyDocumentSignatureToken({
      token: signature.jws,
      signerPublicKeyHex: key,
      signerDid: signature.signerDid,
      documentHash: document.documentHash,
    });
  }));
  const signaturesValid = complete && checks.every(Boolean);
  const revoked = document.revokedAt !== null;
  return { valid: hashMatches && signaturesValid && !revoked, hashMatches, signaturesValid, revoked };
}
