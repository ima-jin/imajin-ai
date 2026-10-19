import { describe, expect, it } from 'vitest';
import { buildAgentReachServices, buildDidDocument } from '../did-document';
import type { ChainVerificationResult } from '../chain-providers';

const DID = 'did:imajin:alice';
const VERIFIED: ChainVerificationResult = {
  valid: true,
  publicKeyMultibase: 'z6Mkalice',
  keyCount: 1,
};
const CARD_URL = 'https://node.example/alice/card';
describe('method-neutral AgentReach publishing', () => {
  it('lets a did:web document owner publish a hint without inventing an identity mapping', () => {
    const webDid = 'did:web:example.org:people:alice';
    const hostedDocument = {
      id: webDid,
      verificationMethod: [{ id: `${webDid}#key-1`, publicKeyMultibase: 'zOwnerKey' }],
      service: buildAgentReachServices(webDid, CARD_URL),
    };
    expect(hostedDocument.service).toEqual([{
      id: `${webDid}#agent-reach`,
      type: 'AgentReach',
      serviceEndpoint: CARD_URL,
    }]);
    expect(hostedDocument.verificationMethod[0].publicKeyMultibase).toBe('zOwnerKey');
  });

  it('omits discovery for a did:web document without an eligible reach card', () => {
    expect(buildAgentReachServices('did:web:example.org', undefined)).toEqual([]);
  });
});

describe('buildDidDocument reach discovery', () => {
  it('keeps discovery optional for pure non-HTTP callers', () => {
    const doc = buildDidDocument(DID, VERIFIED);
    expect(doc?.service).toEqual([{
      id: `${DID}#chain`,
      type: 'ImajinChain',
      serviceEndpoint: `/.well-known/did-imajin/${encodeURIComponent(DID)}`,
    }]);
  });

  it('adds a card transport hint without changing verified authority', () => {
    const baseline = buildDidDocument(DID, VERIFIED, { headCid: 'head-cid' });
    const doc = buildDidDocument(DID, VERIFIED, {
      headCid: 'head-cid',
      reachCardEndpoint: CARD_URL,
    });
    expect(doc?.service).toEqual([
      ...baseline!.service,
      { id: `${DID}#agent-reach`, type: 'AgentReach', serviceEndpoint: CARD_URL },
    ]);
    expect({ ...doc, service: [] }).toEqual({ ...baseline, service: [] });
  });

  it.each([
    { valid: false, publicKeyMultibase: 'z6Mkalice' },
    { ...VERIFIED, isDeleted: true },
    { valid: true },
  ])('never lets a reach endpoint substitute for valid verification keys: %j', (result) => {
    expect(buildDidDocument(DID, result, { reachCardEndpoint: CARD_URL })).toBeNull();
  });

  it('preserves role-separated verification and DFOS metadata with reach enabled', () => {
    const doc = buildDidDocument(DID, {
      valid: true,
      keys: {
        auth: [{ publicKeyMultibase: 'zAuth' }],
        assert: [{ publicKeyMultibase: 'zAssert' }],
        controller: [{ publicKeyMultibase: 'zController' }],
      },
    }, { dfosDid: 'did:dfos:alice', reachCardEndpoint: CARD_URL });
    expect(doc?.authentication).toEqual([`${DID}#auth-key-1`]);
    expect(doc?.assertionMethod).toEqual([`${DID}#assert-key-1`]);
    expect(doc?.capabilityInvocation).toEqual([`${DID}#controller-key-1`]);
    expect(doc?.['imajin:dfosDid']).toBe('did:dfos:alice');
  });
});
