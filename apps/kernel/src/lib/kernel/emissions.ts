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
 *
 * The payload amount is in fiat cents (e.g. 1000 = $10.00).
 * Convert to dollars, apply percentage, then convert to MJN.
 * 1 MJN = $0.01, so $1 = 100 MJN.
 *
 * Example: 0.25% of $10.00 (1000 cents) = $0.025 = 2.5 MJN
 */
export function resolveAmount(rule: EmissionRule, settlementCents?: number): number {
  if (typeof rule.amount === 'number') return rule.amount;

  // Parse percentage string like '0.25%'
  const match = rule.amount.match(/^([\d.]+)%$/);
  if (!match) {
    console.warn(`[emissions] Invalid amount format: ${rule.amount}`);
    return 0;
  }

  const pct = parseFloat(match[1]) / 100;
  const baseDollars = (settlementCents ?? 0) / 100; // cents → dollars
  const dollarAmount = baseDollars * pct;            // percentage of dollars
  const mjn = dollarAmount * 100;                    // dollars → MJN ($0.01 per MJN)
  return Math.floor(mjn * 100) / 100;               // floor to 2 decimal places
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
