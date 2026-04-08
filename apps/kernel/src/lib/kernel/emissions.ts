/**
 * MJN Emission Schedule
 *
 * Defines MJN emissions triggered by attestations.
 * Gas burns MJN. Attestations prove. .fair defines. Chains record.
 *
 * Phase 1: static config (this file)
 * Phase 2: .fair cascade (root → identity → record)
 * Phase 3: DFOS chain entries
 *
 * Valuation: 1 MJN = 0.01 CHF (≈1¢). 100 MJN = 1 MJNx.
 */

export interface EmissionRule {
  /** Who receives the emission */
  to: 'subject' | 'issuer' | 'scope' | 'node';
  /** Fixed MJN amount, or percentage string like '0.25%' (of settlement value in payload.amount) */
  amount: number | string;
  /** Human-readable reason for ledger display */
  reason: string;
}

export interface EmissionSpec {
  /** Gas cost in MJN for this attestation type (0 = free) */
  gas: number;
  /** MJN emissions triggered by this attestation */
  emit: EmissionRule[];
}

/**
 * Static emission schedule — keyed by attestation type.
 * Only types listed here trigger emissions.
 */
export const EMISSION_SCHEDULE: Record<string, EmissionSpec> = {
  // === Identity lifecycle (tiered: 10 + 100 + 100 = 210 MJN) ===
  'identity.created': {
    gas: 0,
    emit: [
      { to: 'subject', amount: 10, reason: 'Welcome to the network' },
    ],
  },
  'identity.verified.preliminary': {
    gas: 0,
    emit: [
      { to: 'subject', amount: 100, reason: 'Preliminary verification' },
    ],
  },
  'identity.verified.hard': {
    gas: 0,
    emit: [
      { to: 'subject', amount: 100, reason: 'Full identity verified' },
    ],
  },

  // === Connections ===
  'connection.accepted': {
    gas: 0.001,
    emit: [
      { to: 'subject', amount: 1, reason: 'Connection accepted' },
      { to: 'issuer', amount: 1, reason: 'Connection accepted' },
    ],
  },
  'vouch': {
    gas: 0.001,
    emit: [
      { to: 'subject', amount: 2, reason: 'Vouched for' },
    ],
  },

  // === Commerce ===
  'ticket.purchased': {
    gas: 0.01,
    emit: [
      { to: 'subject', amount: '0.25%', reason: 'Ticket purchase reward' },
      { to: 'issuer', amount: '0.25%', reason: 'Ticket sale reward' },
    ],
  },
  'listing.purchased': {
    gas: 0.01,
    emit: [
      { to: 'subject', amount: '0.25%', reason: 'Purchase reward' },
      { to: 'issuer', amount: '0.25%', reason: 'Sale reward' },
    ],
  },
  'tip.granted': {
    gas: 0.001,
    emit: [
      { to: 'issuer', amount: 1, reason: 'Generosity reward' },
      { to: 'subject', amount: '0.5%', reason: 'Tip received' },
    ],
  },

  // === Content & Creation ===
  'event.attendance': {
    gas: 0.001,
    emit: [
      { to: 'subject', amount: 0.002, reason: 'Event attended' },
    ],
  },
  'event.created': {
    gas: 0.01,
    emit: [
      { to: 'issuer', amount: 5, reason: 'Event created' },
    ],
  },
  'handle.claimed': {
    gas: 0.01,
    emit: [
      { to: 'subject', amount: 2, reason: 'Handle claimed' },
    ],
  },

  // === Groups & Scoping ===
  'group.created': {
    gas: 0.01,
    emit: [
      { to: 'issuer', amount: 10, reason: 'Forest created' },
    ],
  },
  'scope.onboard': {
    gas: 0.001,
    emit: [
      { to: 'subject', amount: 5, reason: 'Joined community' },
      { to: 'scope', amount: 1, reason: 'New member onboarded' },
    ],
  },
};

/**
 * Resolve a percentage emission amount against a settlement value.
 * '0.25%' of 1850 (in MJNx cents) = 4.625 MJN
 *
 * Conversion: settlement is in MJNx, emission is in MJN.
 * 1 MJNx = 100 MJN, so percentage of MJNx value × 100 = MJN amount.
 */
export function resolveAmount(rule: EmissionRule, settlementMjnx?: number): number {
  if (typeof rule.amount === 'number') return rule.amount;

  // Parse percentage string like '0.25%'
  const match = rule.amount.match(/^([\d.]+)%$/);
  if (!match) {
    console.warn(`[emissions] Invalid amount format: ${rule.amount}`);
    return 0;
  }

  const pct = parseFloat(match[1]) / 100;
  const base = settlementMjnx ?? 0;
  // base is in MJNx, result is in MJN (100 MJN = 1 MJNx)
  return Math.floor(base * pct * 100 * 100) / 100; // floor to 2 decimal places
}

/**
 * Resolve the target DID for an emission rule.
 */
export function resolveTarget(
  rule: EmissionRule,
  attestation: { issuerDid: string; subjectDid: string; scopeDid?: string | null; nodeDid?: string | null }
): string | null {
  switch (rule.to) {
    case 'subject': return attestation.subjectDid;
    case 'issuer': return attestation.issuerDid;
    case 'scope': return attestation.scopeDid ?? null;
    case 'node': return attestation.nodeDid ?? null;
    default: return null;
  }
}
