/**
 * DecisionCard view helpers (#2323) — the pure, side-effect-free half of the
 * /jin Inbox rendering of a `decision:card` approval row.
 *
 * Deliberately free of runtime imports (type-only imports from `./schema`
 * are erased) so the client bundle for `operator-approvals-panel.tsx` can
 * use it without pulling in `node:crypto`, the DB, or the logger — and so
 * the server-side prose renderer in `./emit.ts` and the browser `ev:` strip
 * share ONE formatter and can never drift apart.
 */
import type {
  DecisionCardAuthorityEvidence,
  DecisionCardBlockersEvidence,
  DecisionCardCiEvidence,
  DecisionCardEvidence,
  DecisionCardOption,
  DecisionCardPrEvidence,
  DecisionCardRec,
  DecisionCardReviewEvidence,
  DecisionCardRunEvidence,
  DecisionCardSonarEvidence,
  DecisionCardSubject,
} from './schema';

/** Open-vocabulary `source` the emitter raises on operator.approvals (#2152). */
export const DECISION_APPROVAL_SOURCE = 'decision';
/** `'<source>:<subkind>'` per #2152's namespaced-kind rule. */
export const DECISION_APPROVAL_KIND = 'decision:card';

/** Marks a missing piece of evidence — "missing is data" (#2315), never dropped from the line. */
const MISSING = '?';

export interface DecisionCardEvidenceField {
  key: string;
  value: string;
}

function fmtPr(evidence?: DecisionCardPrEvidence): string {
  if (!evidence) return MISSING;
  let mergeable = 'conflict';
  if (evidence.mergeable === null) mergeable = 'unknown';
  else if (evidence.mergeable) mergeable = 'mergeable';
  return `#${evidence.number}(${evidence.draft ? 'draft' : 'ready'},${mergeable})`;
}

function fmtCi(evidence?: DecisionCardCiEvidence): string {
  return evidence ? evidence.conclusion : MISSING;
}

function fmtSonar(evidence?: DecisionCardSonarEvidence): string {
  if (!evidence) return MISSING;
  return `${evidence.qualityGate}(new:${evidence.newIssues})`;
}

function fmtReview(evidence?: DecisionCardReviewEvidence): string {
  return evidence ? evidence.verdict : MISSING;
}

function fmtRun(evidence?: DecisionCardRunEvidence): string {
  return evidence ? evidence.status : MISSING;
}

function countOf(list: unknown): number {
  return Array.isArray(list) ? list.length : 0;
}

function fmtBlockers(evidence?: DecisionCardBlockersEvidence): string {
  if (!evidence) return MISSING;
  return `${countOf(evidence.blockedBy)}blocked/${countOf(evidence.blocks)}blocks`;
}

function fmtAuthority(evidence: DecisionCardAuthorityEvidence | undefined): string {
  if (!evidence) return MISSING;
  return evidence.canActWithoutHuman ? 'auto' : 'human';
}

/**
 * The `ev:` fields — EVERY evidence key appears, in a fixed order; a key
 * whose evidence is absent renders `?` rather than being dropped, so the
 * strip's shape never depends on which evidence happened to be available
 * (#2315 acceptance). `evidence` itself may be absent on an untrusted row,
 * in which case every field is `?`.
 */
export function decisionCardEvidenceFields(evidence: Partial<DecisionCardEvidence> | null | undefined): DecisionCardEvidenceField[] {
  const ev = evidence ?? {};
  return [
    { key: 'pr', value: fmtPr(ev.pr) },
    { key: 'ci', value: fmtCi(ev.ci) },
    { key: 'sonar', value: fmtSonar(ev.sonar) },
    { key: 'review', value: fmtReview(ev.review) },
    { key: 'run', value: fmtRun(ev.run) },
    { key: 'blockers', value: fmtBlockers(ev.blockers) },
    { key: 'authority', value: fmtAuthority(ev.authority) },
  ];
}

/** The one-line `ev: k=v k=v …` render shared by the prose block (`./emit.ts`). */
export function formatDecisionCardEvidenceLine(evidence: Partial<DecisionCardEvidence> | null | undefined): string {
  return `ev: ${decisionCardEvidenceFields(evidence)
    .map(({ key, value }) => `${key}=${value}`)
    .join(' ')}`;
}

/**
 * What the Inbox needs from a card — the display subset of
 * {@link DecisionCard}. `evidence` is optional here because `detail` on an
 * approvals row is untrusted JSON: a card missing evidence still renders
 * (every `ev:` field shows `?`) rather than falling back to the generic card.
 */
export interface DecisionCardView {
  subject: DecisionCardSubject;
  question: string;
  options: DecisionCardOption[];
  rec: DecisionCardRec;
  evidence: Partial<DecisionCardEvidence> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseSubject(raw: unknown): DecisionCardSubject | null {
  if (!isRecord(raw) || !isNonEmptyString(raw.ref)) return null;
  return {
    kind: raw.kind as DecisionCardSubject['kind'],
    ref: raw.ref,
    url: typeof raw.url === 'string' ? raw.url : '',
  };
}

function parseOptions(raw: unknown): DecisionCardOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const options: DecisionCardOption[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isNonEmptyString(item.letter) || !isNonEmptyString(item.label)) return null;
    options.push({
      letter: item.letter,
      label: item.label,
      consequence: typeof item.consequence === 'string' ? item.consequence : '',
    });
  }
  return options;
}

/**
 * Defensively narrow an approvals row's untrusted `detail` to a
 * {@link DecisionCardView}. Returns `null` when the load-bearing parts
 * (subject ref, question, options, a rec naming one of them) aren't usable
 * — the caller then falls back to the generic summary card rather than
 * rendering a half-card whose buttons could submit a nonsense letter.
 */
export function parseDecisionCardView(detail: Record<string, unknown> | null | undefined): DecisionCardView | null {
  if (!detail) return null;
  const subject = parseSubject(detail.subject);
  const options = parseOptions(detail.options);
  const rec = detail.rec;
  if (!subject || !options || !isNonEmptyString(detail.question) || !isRecord(rec) || !isNonEmptyString(rec.letter)) {
    return null;
  }
  if (!options.some((option) => option.letter === rec.letter)) return null;
  return {
    subject,
    question: detail.question,
    options,
    rec: { letter: rec.letter, why: typeof rec.why === 'string' ? rec.why : '' },
    evidence: isRecord(detail.evidence) ? (detail.evidence as Partial<DecisionCardEvidence>) : null,
  };
}

/** True only for an absolute http(s) URL — `subject.url` is untrusted, and `javascript:` must never become an `href`. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The countersign payload fields for choosing option `letter` (#2323): the
 * existing decision route's `decision` + opaque `mode` — no new route, no
 * new table. `mode` is how a github card's TTL pick already travels
 * (#2293); here it carries the option letter, and the route echoes it onto
 * the signed `operator.approval.decided` payload.
 */
export function decisionCardChoicePayload(letter: string): { decision: 'approve'; mode: string } {
  return { decision: 'approve', mode: letter };
}

/** The option a decided card's recorded `mode` names, or `null` when it names none of the card's options. */
export function findChosenOption(options: readonly DecisionCardOption[], mode: unknown): DecisionCardOption | null {
  if (typeof mode !== 'string') return null;
  return options.find((option) => option.letter === mode) ?? null;
}
