import * as jose from 'jose';
import { crypto as authCrypto } from '@imajin/auth';
import { buildDocumentSigningPayload, parseDocumentSigningPayload } from './document-signing-payload';

function isLikelyCompactJws(token: string): boolean {
  return token.split('.').length === 3;
}

function resolveNodePublicKey(): string | null {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    return authCrypto.getPublicKey(privateKey);
  } catch {
    return null;
  }
}

async function verifyLegacyJws(
  token: string, signerPublicKeyHex: string, signerDid: string, documentHash: string,
): Promise<boolean> {
  try {
    const publicKeyBytes = Buffer.from(signerPublicKeyHex, 'hex');
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: jose.base64url.encode(publicKeyBytes),
    };
    const publicKey = await jose.importJWK(jwk, 'EdDSA');
    const { payload } = await jose.compactVerify(token, publicKey, { algorithms: ['EdDSA'] });
    const parsed = parseDocumentSigningPayload(Buffer.from(payload).toString('utf8'));
    return parsed?.did === signerDid && parsed.document_hash === documentHash;
  } catch {
    return false;
  }
}

export async function verifyDocumentSignatureToken(params: {
  token: string;
  signerPublicKeyHex: string;
  signerDid: string;
  documentHash: string;
}): Promise<boolean> {
  const { token, signerPublicKeyHex, signerDid, documentHash } = params;

  if (isLikelyCompactJws(token)) {
    return verifyLegacyJws(token, signerPublicKeyHex, signerDid, documentHash);
  }

  const nodePublicKey = resolveNodePublicKey();
  if (!nodePublicKey) return false;

  const payload = buildDocumentSigningPayload(signerDid, documentHash);
  return authCrypto.verifySync(token, payload, nodePublicKey);
}
