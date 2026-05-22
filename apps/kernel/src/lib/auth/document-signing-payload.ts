export interface DocumentSigningPayload {
  did: string;
  document_hash: string;
}

export function buildDocumentSigningPayload(did: string, documentHash: string): string {
  return JSON.stringify({
    did,
    document_hash: documentHash,
  });
}

export function parseDocumentSigningPayload(payload: string): DocumentSigningPayload | null {
  try {
    const parsed = JSON.parse(payload) as Partial<DocumentSigningPayload>;
    if (
      typeof parsed.did !== 'string' ||
      !parsed.did.startsWith('did:') ||
      typeof parsed.document_hash !== 'string' ||
      parsed.document_hash.length === 0
    ) {
      return null;
    }
    return {
      did: parsed.did,
      document_hash: parsed.document_hash,
    };
  } catch {
    return null;
  }
}
