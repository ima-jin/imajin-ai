import { describe, it, expect } from 'vitest';
import { buildFairManifest } from '../src/buildManifest';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_DEFAULT_BPS,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
} from '../src/constants';

const CREATOR = 'did:imajin:creator123';
const CONTENT = 'did:imajin:content456';
const SCOPE = 'did:imajin:scope789';
const NODE_OP = 'did:imajin:nodeop';

describe('buildFairManifest', () => {
  it('uses default rates without scope', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
    });

    expect(manifest.version).toBe('0.4.0');

    const protocol = manifest.chain.find((e) => e.role === 'protocol');
    const node = manifest.chain.find((e) => e.role === 'node');
    const buyerCredit = manifest.chain.find((e) => e.role === 'buyer_credit');
    const scope = manifest.chain.find((e) => e.role === 'scope');
    const seller = manifest.chain.find((e) => e.role === 'seller');

    expect(protocol?.share).toBe(PROTOCOL_FEE_BPS / 10000);
    expect(node?.share).toBe(NODE_FEE_DEFAULT_BPS / 10000);
    expect(buyerCredit?.share).toBe(BUYER_CREDIT_DEFAULT_BPS / 10000);
    expect(scope).toBeUndefined();

    const expectedSellerShare =
      1 -
      PROTOCOL_FEE_BPS / 10000 -
      NODE_FEE_DEFAULT_BPS / 10000 -
      BUYER_CREDIT_DEFAULT_BPS / 10000;
    expect(seller?.share).toBeCloseTo(expectedSellerShare, 10);
    expect(seller?.did).toBe(CREATOR);

    // Chain shares must sum to 1
    const total = manifest.chain.reduce((sum, e) => sum + e.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('uses default rates with scope', () => {
    const SCOPE_FEE_BPS = 25;
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      scopeDid: SCOPE,
      scopeFeeBps: SCOPE_FEE_BPS,
    });

    const scope = manifest.chain.find((e) => e.role === 'scope');
    expect(scope?.did).toBe(SCOPE);
    expect(scope?.share).toBe(SCOPE_FEE_BPS / 10000);

    const seller = manifest.chain.find((e) => e.role === 'seller');
    const expectedSellerShare =
      1 -
      PROTOCOL_FEE_BPS / 10000 -
      NODE_FEE_DEFAULT_BPS / 10000 -
      BUYER_CREDIT_DEFAULT_BPS / 10000 -
      SCOPE_FEE_BPS / 10000;
    expect(seller?.share).toBeCloseTo(expectedSellerShare, 10);

    const total = manifest.chain.reduce((sum, e) => sum + e.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('uses custom node and buyer credit rates', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'listing',
      nodeFeeBps: 100,
      buyerCreditBps: 75,
      nodeOperatorDid: NODE_OP,
    });

    const node = manifest.chain.find((e) => e.role === 'node');
    expect(node?.share).toBe(100 / 10000);
    expect(node?.did).toBe(NODE_OP);

    const buyerCredit = manifest.chain.find((e) => e.role === 'buyer_credit');
    expect(buyerCredit?.share).toBe(75 / 10000);

    const total = manifest.chain.reduce((sum, e) => sum + e.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('clamps nodeFeeBps below minimum to NODE_FEE_MIN_BPS', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'course',
      nodeFeeBps: 5, // below min of 25
    });

    const node = manifest.chain.find((e) => e.role === 'node');
    expect(node?.share).toBe(NODE_FEE_MIN_BPS / 10000);
  });

  it('clamps nodeFeeBps above maximum to NODE_FEE_MAX_BPS', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'course',
      nodeFeeBps: 999, // above max of 200
    });

    const node = manifest.chain.find((e) => e.role === 'node');
    expect(node?.share).toBe(NODE_FEE_MAX_BPS / 10000);
  });

  it('clamps buyerCreditBps below minimum to BUYER_CREDIT_MIN_BPS', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'course',
      buyerCreditBps: 1, // below min of 25
    });

    const buyerCredit = manifest.chain.find((e) => e.role === 'buyer_credit');
    expect(buyerCredit?.share).toBe(BUYER_CREDIT_MIN_BPS / 10000);
  });

  it('clamps buyerCreditBps above maximum to BUYER_CREDIT_MAX_BPS', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'course',
      buyerCreditBps: 500, // above max of 200
    });

    const buyerCredit = manifest.chain.find((e) => e.role === 'buyer_credit');
    expect(buyerCredit?.share).toBe(BUYER_CREDIT_MAX_BPS / 10000);
  });

  it('uses collaborators in distributions', () => {
    const collaborators = [
      { did: 'did:imajin:collab1', role: 'creator', share: 0.7 },
      { did: 'did:imajin:collab2', role: 'collaborator', share: 0.3 },
    ];
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'course',
      collaborators,
    });

    expect(manifest.distributions).toHaveLength(2);
    expect(manifest.distributions[0].did).toBe('did:imajin:collab1');
    expect(manifest.distributions[0].share).toBe(0.7);
    expect(manifest.distributions[1].did).toBe('did:imajin:collab2');
    expect(manifest.distributions[1].share).toBe(0.3);
  });

  it('falls back to creator-only distribution when no collaborators', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
    });

    expect(manifest.distributions).toHaveLength(1);
    expect(manifest.distributions[0].did).toBe(CREATOR);
    expect(manifest.distributions[0].role).toBe('creator');
    expect(manifest.distributions[0].share).toBe(1.0);
  });

  it('omits scope entry when scopeDid is provided but scopeFeeBps is null', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
      scopeDid: SCOPE,
      scopeFeeBps: null,
    });

    const scope = manifest.chain.find((e) => e.role === 'scope');
    expect(scope).toBeUndefined();
  });

  it('uses PROTOCOL_DID for protocol entry', () => {
    const manifest = buildFairManifest({
      creatorDid: CREATOR,
      contentDid: CONTENT,
      contentType: 'event',
    });

    const protocol = manifest.chain.find((e) => e.role === 'protocol');
    expect(protocol?.did).toBe(PROTOCOL_DID);
  });
});
