/**
 * DID Document builder — RFC-40 §3.2
 *
 * Derives a W3C DID Document from a verified DFOS chain.
 * The document is an *output of verification*, never an input to trust.
 *
 * Design invariant (RFC-40 §2): No Imajin service is a trusted third party
 * in resolution. The transport (this endpoint) is a dumb pipe; trust comes
 * only from cryptographically verifying the chain log.
 */

import type { ChainVerificationResult } from './chain-providers';

/** W3C verification method object */
export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

/** Imajin chain service descriptor — untrusted transport hint */
export interface ImajinChainService {
  id: string;
  type: 'ImajinChain';
  serviceEndpoint: string;
}

/** W3C DID Document (RFC-40 §3.2) */
export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityInvocation?: string[];
  service: ImajinChainService[];
  'imajin:chainHead': string;
  'imajin:keyCount': number;
  'imajin:dfosDid'?: string;
}

export interface BuildDidDocumentOptions {
  /** Untrusted transport hint — where a verifier can fetch the chain log */
  chainEndpoint?: string;
  /** DFOS DID alias (did:dfos:...) to include as metadata */
  dfosDid?: string;
  /** CID of the chain head (from identity_chains.headCid) */
  headCid?: string;
}

/**
 * Build a W3C DID Document from a verified chain result.
 *
 * Requires `chainResult.valid === true`.
 * Returns null if the chain is invalid or deleted.
 *
 * Per RFC-40 §3.2: all verification methods are Ed25519VerificationKey2020.
 * The `service` endpoint is a *hint* — it carries no authority. Trust comes
 * from the caller re-verifying the chain log via verifyChainLog().
 */
export function buildDidDocument(
  imajinDid: string,
  chainResult: ChainVerificationResult,
  options: BuildDidDocumentOptions = {}
): DidDocument | null {
  if (!chainResult.valid || chainResult.isDeleted) return null;

  const methods: VerificationMethod[] = [];
  const authRefs: string[] = [];
  const assertRefs: string[] = [];
  const controllerRefs: string[] = [];

  const keys = chainResult.keys;

  if (keys && (keys.auth.length > 0 || keys.assert.length > 0)) {
    // Role-separated keys: auth, assert, controller
    for (const [i, key] of keys.auth.entries()) {
      const id = `${imajinDid}#auth-key-${i + 1}`;
      methods.push({
        id,
        type: 'Ed25519VerificationKey2020',
        controller: imajinDid,
        publicKeyMultibase: key.publicKeyMultibase,
      });
      authRefs.push(id);
    }

    for (const [i, key] of keys.assert.entries()) {
      const id = `${imajinDid}#assert-key-${i + 1}`;
      methods.push({
        id,
        type: 'Ed25519VerificationKey2020',
        controller: imajinDid,
        publicKeyMultibase: key.publicKeyMultibase,
      });
      assertRefs.push(id);
    }

    for (const [i, key] of keys.controller.entries()) {
      const id = `${imajinDid}#controller-key-${i + 1}`;
      methods.push({
        id,
        type: 'Ed25519VerificationKey2020',
        controller: imajinDid,
        publicKeyMultibase: key.publicKeyMultibase,
      });
      controllerRefs.push(id);
    }
  } else if (chainResult.publicKeyMultibase) {
    // Fallback: single key (no role separation)
    const id = `${imajinDid}#key-1`;
    methods.push({
      id,
      type: 'Ed25519VerificationKey2020',
      controller: imajinDid,
      publicKeyMultibase: chainResult.publicKeyMultibase,
    });
    authRefs.push(id);
    assertRefs.push(id);
  }

  if (methods.length === 0) return null;

  const chainHead = options.headCid ?? chainResult.did ?? 'unknown';
  const keyCount = chainResult.keyCount ?? methods.length;

  const serviceEndpoint =
    options.chainEndpoint ?? `/.well-known/did-imajin/${encodeURIComponent(imajinDid)}`;

  const doc: DidDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: imajinDid,
    verificationMethod: methods,
    authentication: authRefs.length > 0 ? authRefs : assertRefs,
    assertionMethod: assertRefs.length > 0 ? assertRefs : authRefs,
    service: [
      {
        id: `${imajinDid}#chain`,
        type: 'ImajinChain',
        serviceEndpoint,
      },
    ],
    'imajin:chainHead': chainHead,
    'imajin:keyCount': keyCount,
  };

  if (controllerRefs.length > 0) {
    doc.capabilityInvocation = controllerRefs;
  }

  if (options.dfosDid) {
    doc['imajin:dfosDid'] = options.dfosDid;
  }

  return doc;
}
