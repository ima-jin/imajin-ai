/**
 * Which `mode` a decision may carry, per approval kind (#2693).
 *
 * The operator's countersignature now covers `mode` (see
 * `operator-countersign-fields.ts`), so the route must not let a signature
 * bind a value no card ever offered. `mode` is the operator's CHOICE; this
 * module is the one place that says which choices exist:
 *
 *   - `decision:card` (#2323) — `approve` carries one of the card's own
 *     option letters and MUST (picking an option is the signing event; an
 *     approve naming no option signs nothing about which). `reject` /
 *     `withdrawn` ("none of these") carry no mode.
 *   - `gateway-exec:command` (#2221) — `approve` ⇒ absent | `allow-once`,
 *     `reject` ⇒ absent | `deny` (delegated to
 *     `validateExecCommandDecisionMode`, unchanged).
 *   - `github:*` (#2293) — `approve` ⇒ absent | a TTL (`single`, `5m`,
 *     `24h`); `reject` / `withdrawn` carry no mode.
 *   - every other kind defines no mode: any supplied `mode` is unknown.
 *
 * Pure and DB-free so the service, tests, and any future caller share it.
 */
import { EXEC_COMMAND_KIND, validateExecCommandDecisionMode } from './exec-command-approvals';
import type { ApprovalDecision } from './operator-approvals';

/** Open-vocabulary source github proposals are raised under (#2293). */
export const GITHUB_SOURCE = 'github';

/** The TTL `mode` values a github approve decision may carry, `single` being the default. */
export const GITHUB_TTL_MODES = ['single', '5m', '24h'] as const;

const GITHUB_TTL_LIST = GITHUB_TTL_MODES.map((m) => `'${m}'`).join(', ');

/** `'<source>:<subkind>'` of a DecisionCard approval (#2315) — see `../decisions/emit.ts`. */
export const DECISION_CARD_KIND = 'decision:card';

export type DecisionModeValidation = { ok: true } | { ok: false; error: string };

export interface DecisionModeSubject {
  source: string;
  kind: string;
  detail: Record<string, unknown> | null;
}

/** The option letters a decision card's untrusted `detail` offers (empty when it offers none usable). */
export function decisionCardOptionLetters(detail: Record<string, unknown> | null): string[] {
  const options = detail?.options;
  if (!Array.isArray(options)) return [];
  const letters: string[] = [];
  for (const option of options) {
    const letter = (option as { letter?: unknown } | null)?.letter;
    if (typeof letter === 'string' && letter.length > 0) letters.push(letter);
  }
  return letters;
}

function validateDecisionCardMode(
  decision: ApprovalDecision,
  mode: string | undefined,
  detail: Record<string, unknown> | null,
): DecisionModeValidation {
  if (decision !== 'approve') {
    return mode === undefined
      ? { ok: true }
      : { ok: false, error: `mode must be omitted for a ${decision} decision on a decision card (got '${mode}')` };
  }
  const letters = decisionCardOptionLetters(detail);
  if (mode !== undefined && letters.includes(mode)) return { ok: true };
  const offered = letters.length > 0 ? letters.join(', ') : 'none';
  const got = mode === undefined ? 'no mode' : `'${mode}'`;
  return {
    ok: false,
    error: `mode must be one of the card's option letters (${offered}) for an approve decision on a decision card (got ${got})`,
  };
}

function validateGithubMode(decision: ApprovalDecision, mode: string | undefined): DecisionModeValidation {
  if (mode === undefined) return { ok: true };
  if (decision === 'approve' && (GITHUB_TTL_MODES as readonly string[]).includes(mode)) return { ok: true };
  if (decision === 'approve') {
    return { ok: false, error: `mode must be one of ${GITHUB_TTL_LIST} for a github:* approve decision (got '${mode}')` };
  }
  return { ok: false, error: `mode must be omitted for a ${decision} decision on github:* approvals (got '${mode}')` };
}

/**
 * Validate the `mode` a decision carries for this approval row. `mode`
 * undefined means the decision carries none. Fail-closed: a kind this
 * module doesn't name defines no mode, so any supplied value is refused.
 */
export function validateDecisionMode(
  subject: DecisionModeSubject,
  decision: ApprovalDecision,
  mode: string | undefined,
): DecisionModeValidation {
  if (subject.kind === DECISION_CARD_KIND) return validateDecisionCardMode(decision, mode, subject.detail);
  if (subject.kind === EXEC_COMMAND_KIND) return validateExecCommandDecisionMode(decision, mode);
  if (subject.source === GITHUB_SOURCE) return validateGithubMode(decision, mode);
  if (mode === undefined) return { ok: true };
  return { ok: false, error: `mode is not accepted for ${subject.kind} approvals (got '${mode}')` };
}
