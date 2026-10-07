/**
 * e-Transfer receiving email validation (#2665).
 *
 * Format validation only — nothing is sent to the address and it is never
 * verified against a bank. Procedural rather than one big regex so there is
 * no backtracking to reason about (Sonar S5852), and the rules stay legible.
 */

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

export interface EtransferEmailValidationResult {
  valid: boolean;
  /** Trimmed + lower-cased address; `null` when the field is being cleared. */
  normalized: string | null;
  error?: string;
}

function invalid(error: string): EtransferEmailValidationResult {
  return { valid: false, normalized: null, error };
}

function hasWhitespace(value: string): boolean {
  return [...value].some((ch) => ch.trim() === '');
}

function domainError(domain: string): string | null {
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return 'e-Transfer email must have a domain like example.com';
  }
  if (labels.some((label) => label.startsWith('-') || label.endsWith('-'))) {
    return 'e-Transfer email has an invalid domain';
  }
  return null;
}

/**
 * Validate the owner-supplied e-Transfer receiving email. `null`, `''` and
 * whitespace-only all mean "clear it" and are valid (the issuer stops
 * accepting e-Transfer).
 */
export function validateEtransferEmail(raw: unknown): EtransferEmailValidationResult {
  if (raw === null || raw === undefined) return { valid: true, normalized: null };
  if (typeof raw !== 'string') return invalid('e-Transfer email must be a string');

  const trimmed = raw.trim();
  if (trimmed === '') return { valid: true, normalized: null };
  if (trimmed.length > MAX_EMAIL_LENGTH) return invalid(`e-Transfer email must be ${MAX_EMAIL_LENGTH} characters or fewer`);
  if (hasWhitespace(trimmed)) return invalid('e-Transfer email must not contain spaces');

  const parts = trimmed.split('@');
  if (parts.length !== 2) return invalid('e-Transfer email must contain exactly one @');
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > MAX_LOCAL_LENGTH) {
    return invalid('e-Transfer email has an invalid name before the @');
  }

  const domainProblem = domainError(domain);
  if (domainProblem) return invalid(domainProblem);

  return { valid: true, normalized: trimmed.toLowerCase() };
}
