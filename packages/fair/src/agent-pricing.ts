import {
  PROTOCOL_FEE_BPS,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
} from './constants';

// ============================================================================
// Agent Pricing Manifest
// ============================================================================

export interface AgentPricingManifest {
  fair: '1.0';
  type: 'agent-interaction';
  agent: string; // agent DID
  pricing: {
    session_init?: { amount: number; currency: 'MJNx' };
    token_rate?: {
      input?: { per_1k: number };
      output?: { per_1k: number };
    };
    flat_rate?: { amount: number; currency: 'MJNx'; per: 'message' | 'session' | 'day' };
  };
  fees: Array<{
    role: 'protocol' | 'node' | 'buyer_credit' | 'scope';
    name: string;
    rateBps: number;
  }>;
}

// ============================================================================
// Cost Breakdown
// ============================================================================

export interface AgentCostBreakdown {
  baseCost: number;
  fees: Array<{ role: string; name: string; amount: number }>;
  totalCost: number;
  currency: 'MJNx';
}

// ============================================================================
// Helpers
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bpsToShare(bps: number): number {
  return bps / 10000;
}

function shareToAmount(share: number, base: number): number {
  return Math.round(base * share * 10000) / 10000;
}

function buildDefaultFees(): AgentPricingManifest['fees'] {
  return [
    { role: 'protocol', name: 'Protocol Fee', rateBps: PROTOCOL_FEE_BPS },
    { role: 'node', name: 'Node Fee', rateBps: NODE_FEE_DEFAULT_BPS },
    { role: 'buyer_credit', name: 'Buyer Credit', rateBps: BUYER_CREDIT_DEFAULT_BPS },
    { role: 'scope', name: 'Scope Fee', rateBps: 25 },
  ];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an AgentPricingManifest.
 */
export function validateAgentPricingManifest(
  manifest: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (m.fair !== '1.0') errors.push('fair must be "1.0"');
  if (m.type !== 'agent-interaction') errors.push('type must be "agent-interaction"');
  if (typeof m.agent !== 'string' || !m.agent.startsWith('did:')) {
    errors.push('agent must be a valid DID string');
  }
  if (typeof m.pricing !== 'object' || m.pricing === null) {
    errors.push('pricing must be an object');
  }

  if (!Array.isArray(m.fees)) {
    errors.push('fees must be an array');
  } else {
    const validRoles = ['protocol', 'node', 'buyer_credit', 'scope'];
    for (let i = 0; i < m.fees.length; i++) {
      const fee = m.fees[i] as Record<string, unknown>;
      if (!validRoles.includes(fee.role as string)) {
        errors.push(`fees[${i}].role must be one of ${validRoles.join(', ')}`);
      }
      if (typeof fee.name !== 'string' || !fee.name) {
        errors.push(`fees[${i}].name must be a non-empty string`);
      }
      if (typeof fee.rateBps !== 'number' || fee.rateBps < 0 || fee.rateBps > 10000) {
        errors.push(`fees[${i}].rateBps must be a number between 0 and 10000`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for AgentPricingManifest.
 */
export function isValidAgentPricingManifest(
  manifest: unknown
): manifest is AgentPricingManifest {
  return validateAgentPricingManifest(manifest).valid;
}

// ============================================================================
// Cost Calculator
// ============================================================================

/**
 * Calculate the cost of an agent interaction.
 *
 * Fee cascade order:
 *   1. Base cost = token costs + optional session_init + optional flat_rate
 *   2. Protocol fee (fixed, governance-controlled)
 *   3. Node fee (operator-configurable, clamped to bounds)
 *   4. Buyer credit (operator-configurable, clamped to bounds)
 *   5. Scope fee (optional, only when present in manifest fees)
 *
 * Fees are applied as percentages of the base cost.
 */
export function calculateAgentInteractionCost(params: {
  manifest: AgentPricingManifest;
  tokensIn: number;
  tokensOut: number;
  includeSessionInit?: boolean;
}): AgentCostBreakdown {
  const { manifest, tokensIn, tokensOut, includeSessionInit } = params;

  // --- Calculate base cost ---
  let baseCost = 0;

  // Session init fee
  if (includeSessionInit && manifest.pricing.session_init?.amount) {
    baseCost += manifest.pricing.session_init.amount;
  }

  // Token rates
  if (manifest.pricing.token_rate?.input?.per_1k) {
    baseCost += (tokensIn / 1000) * manifest.pricing.token_rate.input.per_1k;
  }
  if (manifest.pricing.token_rate?.output?.per_1k) {
    baseCost += (tokensOut / 1000) * manifest.pricing.token_rate.output.per_1k;
  }

  // Flat rate (for a single interaction, we count it once)
  // The caller decides whether to include it based on per: 'message' | 'session' | 'day'
  if (manifest.pricing.flat_rate?.amount) {
    baseCost += manifest.pricing.flat_rate.amount;
  }

  // Round base cost to 4 decimal places for MJNx precision
  baseCost = Math.round(baseCost * 10000) / 10000;

  // --- Apply fee cascade ---
  const fees: Array<{ role: string; name: string; amount: number }> = [];
  let runningTotal = baseCost;

  // Look up each fee layer from the manifest (or use defaults)
  const feeMap = new Map<string, { name: string; rateBps: number }>();

  // Start with defaults, then override from manifest
  const defaults = buildDefaultFees();
  for (const f of defaults) {
    feeMap.set(f.role, { name: f.name, rateBps: f.rateBps });
  }

  for (const f of manifest.fees) {
    feeMap.set(f.role, { name: f.name, rateBps: f.rateBps });
  }

  // Protocol fee: fixed, non-configurable
  const protocolFee = feeMap.get('protocol');
  if (protocolFee) {
    const amount = shareToAmount(bpsToShare(PROTOCOL_FEE_BPS), runningTotal);
    fees.push({ role: 'protocol', name: protocolFee.name, amount });
    runningTotal += amount;
  }

  // Node fee: clamped to operator bounds
  const nodeFee = feeMap.get('node');
  if (nodeFee) {
    const rateBps = clamp(nodeFee.rateBps, NODE_FEE_MIN_BPS, NODE_FEE_MAX_BPS);
    const amount = shareToAmount(bpsToShare(rateBps), runningTotal);
    fees.push({ role: 'node', name: nodeFee.name, amount });
    runningTotal += amount;
  }

  // Buyer credit: clamped to bounds
  const buyerCredit = feeMap.get('buyer_credit');
  if (buyerCredit) {
    const rateBps = clamp(buyerCredit.rateBps, BUYER_CREDIT_MIN_BPS, BUYER_CREDIT_MAX_BPS);
    const amount = shareToAmount(bpsToShare(rateBps), runningTotal);
    fees.push({ role: 'buyer_credit', name: buyerCredit.name, amount });
    runningTotal += amount;
  }

  // Scope fee: only if explicitly present in manifest fees
  const scopeFee = feeMap.get('scope');
  if (scopeFee && manifest.fees.some((f) => f.role === 'scope')) {
    const amount = shareToAmount(bpsToShare(scopeFee.rateBps), runningTotal);
    fees.push({ role: 'scope', name: scopeFee.name, amount });
    runningTotal += amount;
  }

  // Round total to 4 decimal places
  const totalCost = Math.round(runningTotal * 10000) / 10000;

  return {
    baseCost,
    fees,
    totalCost,
    currency: 'MJNx',
  };
}

/**
 * Build a default agent pricing manifest for an agent DID.
 * Uses the default fee model v4: 1% + 0.5% + 0.25% + 0.25% = 2%
 */
export function buildDefaultAgentPricingManifest(agentDid: string): AgentPricingManifest {
  return {
    fair: '1.0',
    type: 'agent-interaction',
    agent: agentDid,
    pricing: {
      token_rate: {
        input: { per_1k: 0.01 },
        output: { per_1k: 0.03 },
      },
    },
    fees: buildDefaultFees(),
  };
}
