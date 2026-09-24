/**
 * DecisionCard schema v1 (#2315).
 *
 * High-definition decision card: a structured evidence bundle that binds
 * everything a human needs to rule under one `contentHash` — subject, the
 * one-line question, the a/b/c options, a recommendation, and an evidence
 * bundle (PR/CI/Sonar/review/run/blockers/authority) rich enough that a
 * local model can cluster and rank the open pile with zero network reads
 * (see `./organize.ts`).
 *
 * Lands as a `kind: 'decision:card'` row on the existing operator.approvals
 * rail (#2059/#2152) via `./emit.ts` — see that module's own docs for why
 * the kind is namespaced `decision:card` rather than the bare `decision`
 * the issue sketch uses (`kind` on that table is a strict
 * `'<source>:<subkind>'` namespace, enforced since #2152). The prose block
 * (`DECISION · subject · question · a/b/c · rec`) is a RENDER of this
 * object, never the source of truth.
 *
 * The /jin Inbox rendering of this shape is deferred to #2288 — this
 * module only defines the shape, its validation, and its content hash.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { generateId } from '../kernel/id';

export type DecisionCardSource = 'review' | 'wake' | 'triage' | 'chat' | 'automation';
export type DecisionCardSubjectKind = 'pr' | 'issue' | 'run' | 'release' | 'config';
export type DecisionCardReviewVerdict = 'APPROVE-READY' | 'NEEDS-FIX' | 'NEEDS-DECISION';
/** GitHub-style priority label (organizer ranking input, #2315) — p0 is the most urgent. */
export type DecisionCardPriority = 'p0' | 'p1' | 'p2' | 'p3';

export interface DecisionCardSubject {
  kind: DecisionCardSubjectKind;
  ref: string;
  url: string;
}

export interface DecisionCardOption {
  letter: string;
  label: string;
  consequence: string;
}

export interface DecisionCardRec {
  letter: string;
  why: string;
}

export interface DecisionCardPrEvidence {
  number: number;
  title: string;
  draft: boolean;
  mergeable: boolean | null;
  base: string;
  head: string;
  headSha: string;
  stackedOn?: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  closes: number[];
}

export interface DecisionCardCiCheck {
  name: string;
  conclusion: string;
  url: string;
}

export interface DecisionCardCiEvidence {
  conclusion: string;
  checks: DecisionCardCiCheck[];
}

export interface DecisionCardSonarEvidence {
  qualityGate: string;
  newIssues: number;
  coverageOnNew: number | null;
  url: string;
}

export interface DecisionCardReviewEvidence {
  verdict: DecisionCardReviewVerdict;
  model: string;
  sessionId: string;
  blocking: string[];
  nonBlocking: string[];
  commentUrl: string;
}

export interface DecisionCardRunEvidence {
  warpRunId: string;
  status: string;
  durationMs: number;
  resumes: number;
  branches: string[];
}

export interface DecisionCardBlockerRef {
  number: number;
  state: string;
}

export interface DecisionCardBlockersEvidence {
  blockedBy: DecisionCardBlockerRef[];
  blocks: DecisionCardBlockerRef[];
}

export interface DecisionCardAuthorityEvidence {
  canActWithoutHuman: boolean;
  rule: string;
}

export interface DecisionCardEvidence {
  pr?: DecisionCardPrEvidence;
  ci?: DecisionCardCiEvidence;
  sonar?: DecisionCardSonarEvidence;
  review?: DecisionCardReviewEvidence;
  run?: DecisionCardRunEvidence;
  blockers?: DecisionCardBlockersEvidence;
  /** Never implied — an explicit evaluation of the standing merge/bump/deploy rules (#2315). Required, unlike every other evidence key. */
  authority: DecisionCardAuthorityEvidence;
}

export interface DecisionCardRuling {
  letter: string;
  note?: string;
  decidedBy: string;
  decidedAt: string;
  /** Written by the #2082/#2294 countersign path — `./emit.ts` never sets this. */
  operatorSig: string;
}

/**
 * The fields a `contentHash` covers — everything on the card except
 * `ruling` (#2315: "contentHash over everything except ruling") and
 * `contentHash` itself.
 */
export interface DecisionCardHashedFields {
  id: string;
  createdAt: string;
  correlationId?: string;
  source: DecisionCardSource;
  priority?: DecisionCardPriority;
  subject: DecisionCardSubject;
  question: string;
  options: DecisionCardOption[];
  rec: DecisionCardRec;
  evidence: DecisionCardEvidence;
}

export interface DecisionCard extends DecisionCardHashedFields {
  contentHash: string;
  /** Written by the ruling/countersign path (#2082/#2294) — `./emit.ts` never sets this. */
  ruling?: DecisionCardRuling;
}

/**
 * Input to {@link createDecisionCard} — everything but the fields the
 * schema itself assigns (`id`, `createdAt`). Both may still be supplied
 * explicitly (e.g. a test fixture, or a caller re-hydrating a card), in
 * which case they're used as-is rather than regenerated.
 */
export type DecisionCardInput = Omit<DecisionCardHashedFields, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: string;
};

const DECISION_CARD_SOURCES: ReadonlySet<DecisionCardSource> = new Set(['review', 'wake', 'triage', 'chat', 'automation']);
const DECISION_CARD_SUBJECT_KINDS: ReadonlySet<DecisionCardSubjectKind> = new Set(['pr', 'issue', 'run', 'release', 'config']);
const DECISION_CARD_PRIORITIES: ReadonlySet<DecisionCardPriority> = new Set(['p0', 'p1', 'p2', 'p3']);
const REVIEW_VERDICTS: ReadonlySet<DecisionCardReviewVerdict> = new Set(['APPROVE-READY', 'NEEDS-FIX', 'NEEDS-DECISION']);
/** a/b at minimum — a decision with a single option isn't a decision. */
const MIN_OPTIONS = 2;
const MAX_QUESTION_LENGTH = 500;

export interface DecisionCardValidationResult {
  ok: boolean;
  error?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSubject(subject: unknown): DecisionCardValidationResult {
  if (typeof subject !== 'object' || subject === null) {
    return { ok: false, error: 'subject is required' };
  }
  const { kind, ref, url } = subject as Record<string, unknown>;
  if (typeof kind !== 'string' || !DECISION_CARD_SUBJECT_KINDS.has(kind as DecisionCardSubjectKind)) {
    return { ok: false, error: "subject.kind must be one of 'pr' | 'issue' | 'run' | 'release' | 'config'" };
  }
  if (!isNonEmptyString(ref)) return { ok: false, error: 'subject.ref is required' };
  if (!isNonEmptyString(url)) return { ok: false, error: 'subject.url is required' };
  return { ok: true };
}

function validateOptions(options: unknown): DecisionCardValidationResult {
  if (!Array.isArray(options) || options.length < MIN_OPTIONS) {
    return { ok: false, error: `options must be an array with at least ${MIN_OPTIONS} entries` };
  }
  const seenLetters = new Set<string>();
  for (const option of options) {
    if (typeof option !== 'object' || option === null) return { ok: false, error: 'each option must be an object' };
    const { letter, label, consequence } = option as Record<string, unknown>;
    if (!isNonEmptyString(letter)) return { ok: false, error: 'option.letter is required' };
    if (seenLetters.has(letter)) return { ok: false, error: `duplicate option letter '${letter}'` };
    seenLetters.add(letter);
    if (!isNonEmptyString(label)) return { ok: false, error: 'option.label is required' };
    if (!isNonEmptyString(consequence)) return { ok: false, error: 'option.consequence is required' };
  }
  return { ok: true };
}

function validateRec(rec: unknown, options: unknown[]): DecisionCardValidationResult {
  if (typeof rec !== 'object' || rec === null) return { ok: false, error: 'rec is required' };
  const { letter, why } = rec as Record<string, unknown>;
  if (!isNonEmptyString(letter)) return { ok: false, error: 'rec.letter is required' };
  const letters = options.map((option) => (option as Record<string, unknown>).letter);
  if (!letters.includes(letter)) {
    return { ok: false, error: `rec.letter '${String(letter)}' must match one of the options' letters` };
  }
  if (!isNonEmptyString(why)) return { ok: false, error: 'rec.why is required' };
  return { ok: true };
}

function validateAuthority(authority: unknown): DecisionCardValidationResult {
  if (typeof authority !== 'object' || authority === null) {
    return { ok: false, error: 'evidence.authority is required — never implied' };
  }
  const { canActWithoutHuman, rule } = authority as Record<string, unknown>;
  if (typeof canActWithoutHuman !== 'boolean') {
    return { ok: false, error: 'evidence.authority.canActWithoutHuman must be a boolean' };
  }
  if (!isNonEmptyString(rule)) return { ok: false, error: 'evidence.authority.rule is required' };
  return { ok: true };
}

function validateReview(review: unknown): DecisionCardValidationResult {
  if (review === undefined) return { ok: true };
  if (typeof review !== 'object' || review === null) return { ok: false, error: 'evidence.review must be an object' };
  const { verdict } = review as Record<string, unknown>;
  if (typeof verdict !== 'string' || !REVIEW_VERDICTS.has(verdict as DecisionCardReviewVerdict)) {
    return { ok: false, error: "evidence.review.verdict must be one of 'APPROVE-READY' | 'NEEDS-FIX' | 'NEEDS-DECISION'" };
  }
  return { ok: true };
}

/**
 * Structural evidence validation. Deep per-kind checks stop at `authority`
 * (required — #2315's "never implied") and `review.verdict` (a closed enum
 * other code branches on, e.g. the organizer's ranking); the remaining
 * evidence kinds are provider-shaped JSON, same posture `detail` already
 * gets at the notify boundary (`../notify/operator-approvals.ts`).
 */
function validateEvidence(evidence: unknown): DecisionCardValidationResult {
  if (typeof evidence !== 'object' || evidence === null) {
    return { ok: false, error: 'evidence is required' };
  }
  const { authority, review } = evidence as Record<string, unknown>;
  const authorityResult = validateAuthority(authority);
  if (!authorityResult.ok) return authorityResult;
  return validateReview(review);
}

/**
 * Validate a DecisionCard-shaped object before `id`/`createdAt`/
 * `contentHash` are assigned (i.e. a {@link DecisionCardInput}).
 */
export function validateDecisionCardInput(input: Record<string, unknown>): DecisionCardValidationResult {
  const { source, priority, subject, question, options, rec, evidence } = input;

  if (typeof source !== 'string' || !DECISION_CARD_SOURCES.has(source as DecisionCardSource)) {
    return { ok: false, error: "source must be one of 'review' | 'wake' | 'triage' | 'chat' | 'automation'" };
  }
  if (priority !== undefined && (typeof priority !== 'string' || !DECISION_CARD_PRIORITIES.has(priority as DecisionCardPriority))) {
    return { ok: false, error: "priority must be one of 'p0' | 'p1' | 'p2' | 'p3'" };
  }

  const subjectResult = validateSubject(subject);
  if (!subjectResult.ok) return subjectResult;

  if (!isNonEmptyString(question) || (question as string).length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `question is required (max ${MAX_QUESTION_LENGTH} chars)` };
  }

  const optionsResult = validateOptions(options);
  if (!optionsResult.ok) return optionsResult;

  const recResult = validateRec(rec, options as unknown[]);
  if (!recResult.ok) return recResult;

  return validateEvidence(evidence);
}

/**
 * Deep-strip own-enumerable keys whose value is `undefined` so two
 * logically-identical objects — one built with `{ correlationId: undefined
 * }`, the other omitting the key entirely — always canonicalize (and
 * therefore hash) identically. `canonicalize` itself renders a present
 * `undefined` value as the literal string `"undefined"` rather than
 * dropping the key, so without this the same card could hash two
 * different ways purely based on caller construction style.
 */
function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) continue;
      result[key] = pruneUndefined(val);
    }
    return result as T;
  }
  return value;
}

/**
 * Canonical sha256 hex digest over the card's hashed fields (#2315: "over
 * everything above" except `ruling`) — stable across re-renders because
 * (a) `canonicalize` sorts object keys deterministically (the same
 * primitive `packages/auth/src/sign.ts` uses for signed-message payloads),
 * and (b) {@link pruneUndefined} normalizes away representational noise
 * from optional fields before hashing.
 */
export function computeDecisionCardContentHash(fields: DecisionCardHashedFields): string {
  return createHash('sha256').update(canonicalize(pruneUndefined(fields))).digest('hex');
}

export type CreateDecisionCardResult = { ok: true; card: DecisionCard } | { ok: false; error: string };

/**
 * Build a fully-formed, validated {@link DecisionCard} from an input that
 * omits the fields the schema itself owns (`id`, `createdAt`,
 * `contentHash`) — the one place those get assigned, so two cards built
 * from equivalent input always hash the same way regardless of caller.
 */
export function createDecisionCard(input: DecisionCardInput): CreateDecisionCardResult {
  const validation = validateDecisionCardInput(input as unknown as Record<string, unknown>);
  if (!validation.ok) return { ok: false, error: validation.error ?? 'invalid DecisionCard input' };

  const hashedFields: DecisionCardHashedFields = {
    id: input.id ?? generateId('dcard'),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    source: input.source,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    subject: input.subject,
    question: input.question,
    options: input.options,
    rec: input.rec,
    evidence: input.evidence,
  };

  const contentHash = computeDecisionCardContentHash(hashedFields);
  return { ok: true, card: { ...hashedFields, contentHash } };
}
