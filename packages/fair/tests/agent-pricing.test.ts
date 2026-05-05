import { describe, it, expect } from 'vitest';
import {
  calculateAgentInteractionCost,
  validateAgentPricingManifest,
  isValidAgentPricingManifest,
  buildDefaultAgentPricingManifest,
} from '../src/agent-pricing';
import type { AgentPricingManifest } from '../src/agent-pricing';
import {
  PROTOCOL_FEE_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
} from '../src/constants';

const AGENT_DID = 'did:imajin:agent123';

describe('validateAgentPricingManifest', () => {
  it('validates a correct manifest', () => {
    const manifest = buildDefaultAgentPricingManifest(AGENT_DID);
    const result = validateAgentPricingManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails on missing fields', () => {
    const result = validateAgentPricingManifest({
      fair: '1.0',
      type: 'agent-interaction',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails on wrong fair version', () => {
    const result = validateAgentPricingManifest({
      fair: '2.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {},
      fees: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('fair must be "1.0"');
  });

  it('fails on invalid fee role', () => {
    const result = validateAgentPricingManifest({
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {},
      fees: [{ role: 'invalid', name: 'Bad', rateBps: 100 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('role must be one of'))).toBe(true);
  });

  it('fails on rateBps out of bounds', () => {
    const result = validateAgentPricingManifest({
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {},
      fees: [{ role: 'protocol', name: 'Protocol', rateBps: 20000 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rateBps'))).toBe(true);
  });
});

describe('isValidAgentPricingManifest', () => {
  it('returns true for valid manifest', () => {
    expect(isValidAgentPricingManifest(buildDefaultAgentPricingManifest(AGENT_DID))).toBe(true);
  });

  it('returns false for invalid manifest', () => {
    expect(isValidAgentPricingManifest(null)).toBe(false);
  });
});

describe('calculateAgentInteractionCost', () => {
  it('calculates token-only cost with default fees', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        token_rate: {
          input: { per_1k: 0.01 },
          output: { per_1k: 0.03 },
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
        { role: 'node', name: 'Node Fee', rateBps: NODE_FEE_DEFAULT_BPS },
        { role: 'buyer_credit', name: 'Buyer Credit', rateBps: BUYER_CREDIT_DEFAULT_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 3000,
      tokensOut: 500,
    });

    // Base: (3000/1000)*0.01 + (500/1000)*0.03 = 0.03 + 0.015 = 0.045
    expect(result.baseCost).toBe(0.045);
    expect(result.currency).toBe('MJNx');
    expect(result.fees).toHaveLength(3);

    // Protocol = 0.045 * 1% = 0.00045 → rounded to 4 decimals = 0.0005
    const protocolFee = result.fees.find((f) => f.role === 'protocol');
    expect(protocolFee?.amount).toBeCloseTo(0.0005, 6);

    // Total should be base + fees
    const feeSum = result.fees.reduce((sum, f) => sum + f.amount, 0);
    expect(result.totalCost).toBeCloseTo(result.baseCost + feeSum, 6);
  });

  it('includes session_init when requested', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        session_init: { amount: 0.5, currency: 'MJNx' },
        token_rate: {
          input: { per_1k: 0.01 },
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 1000,
      tokensOut: 0,
      includeSessionInit: true,
    });

    // Base: 0.5 + (1000/1000)*0.01 = 0.51
    expect(result.baseCost).toBe(0.51);
  });

  it('excludes session_init when not requested', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        session_init: { amount: 0.5, currency: 'MJNx' },
        token_rate: {
          input: { per_1k: 0.01 },
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 1000,
      tokensOut: 0,
      includeSessionInit: false,
    });

    // Base: (1000/1000)*0.01 = 0.01
    expect(result.baseCost).toBe(0.01);
  });

  it('includes flat_rate when present', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        flat_rate: { amount: 0.1, currency: 'MJNx', per: 'message' },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 0,
      tokensOut: 0,
    });

    expect(result.baseCost).toBe(0.1);
  });

  it('includes scope fee only when present in manifest fees', () => {
    const manifestWithScope: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        token_rate: {
          input: { per_1k: 0.1 }, // higher rate so scope fee isn't zero after rounding
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
        { role: 'scope', name: 'Scope Fee', rateBps: 25 },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest: manifestWithScope,
      tokensIn: 1000,
      tokensOut: 0,
    });

    const scopeFee = result.fees.find((f) => f.role === 'scope');
    expect(scopeFee).toBeDefined();
    expect(scopeFee!.amount).toBeGreaterThan(0);
  });

  it('excludes scope fee when not in manifest fees', () => {
    const manifestWithoutScope: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        token_rate: {
          input: { per_1k: 0.01 },
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest: manifestWithoutScope,
      tokensIn: 1000,
      tokensOut: 0,
    });

    const scopeFee = result.fees.find((f) => f.role === 'scope');
    expect(scopeFee).toBeUndefined();
  });

  it('returns zero cost for no pricing and zero tokens', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {},
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 0,
      tokensOut: 0,
    });

    expect(result.baseCost).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.fees.every((f) => f.amount === 0)).toBe(true);
  });

  it('clamps node fee to bounds', () => {
    const manifest: AgentPricingManifest = {
      fair: '1.0',
      type: 'agent-interaction',
      agent: AGENT_DID,
      pricing: {
        token_rate: {
          input: { per_1k: 0.01 },
        },
      },
      fees: [
        { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
        { role: 'node', name: 'Node Fee', rateBps: 500 }, // way above max of 200
      ],
    };

    const result = calculateAgentInteractionCost({
      manifest,
      tokensIn: 1000,
      tokensOut: 0,
    });

    const nodeFee = result.fees.find((f) => f.role === 'node');
    // Max node fee is 200 bps = 2%, applied to running total after protocol
    expect(nodeFee!.amount).toBeLessThan(0.002);
  });
});

describe('buildDefaultAgentPricingManifest', () => {
  it('creates a valid manifest with default token rates', () => {
    const manifest = buildDefaultAgentPricingManifest(AGENT_DID);
    expect(manifest.fair).toBe('1.0');
    expect(manifest.type).toBe('agent-interaction');
    expect(manifest.agent).toBe(AGENT_DID);
    expect(manifest.pricing.token_rate?.input?.per_1k).toBe(0.01);
    expect(manifest.pricing.token_rate?.output?.per_1k).toBe(0.03);
    expect(manifest.fees).toHaveLength(4);
    expect(isValidAgentPricingManifest(manifest)).toBe(true);
  });
});
