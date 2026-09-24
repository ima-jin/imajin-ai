/**
 * DecisionCard emitter (#2315).
 *
 * The one function every future emit site (cycle phases, review
 * sub-agents, the Warp wake handler, chat triage — none of which are
 * wired up by this PR; wiring each of those up is that site's own
 * follow-up) is meant to call: build a `DecisionCard` via
 * `./schema.ts`'s `createDecisionCard`, hand it here, and get back
 *
 *   (a) a durable `operator.approvals` row, following the EXACT write
 *       path #2247 (`../vault/approvals-execution.ts`) and #2252
 *       (`../access/approvals-execution.ts`) both established:
 *       `recordApprovalRequested` from `../notify/operator-approvals-
 *       service.ts` — never a bespoke table.
 *   (b) the prose render that is the human-facing surface for a decision
 *       until the /jin Inbox card ships (#2288).
 *
 * `kind` is `'decision:card'`, not the bare `'decision'` the issue's
 * sketch mentions: `operator.approvals.kind` has been a strict
 * `'<source>:<subkind>'` namespace since #2152
 * (`../notify/operator-approvals.ts`'s `normalizeSourceAndKind`) — every
 * existing consumer (`system-agent:restart`, `vault:mint`,
 * `access:bearer-grant`, ...) follows it, and inventing a bare exception
 * here would break that invariant for any future HTTP-boundary caller.
 * `source: 'decision'` on the approvals row is therefore this emitter's own
 * open-vocabulary namespace — distinct from (and not to be confused with)
 * the `DecisionCard.source` field, which records what EMITTED the card
 * (review/wake/triage/chat/automation), not who raises the approvals row.
 *
 * The prose block is a RENDER of the object: nothing here invents data
 * that isn't already on the card.
 */
import { createLogger } from '@imajin/logger';
import { getOperatorDid } from '../notify/operator-approvals';
import { recordApprovalRequested } from '../notify/operator-approvals-service';
import {
  createDecisionCard,
  type DecisionCard,
  type DecisionCardInput,
  type DecisionCardEvidence,
  type DecisionCardPrEvidence,
  type DecisionCardCiEvidence,
  type DecisionCardSonarEvidence,
  type DecisionCardReviewEvidence,
  type DecisionCardRunEvidence,
  type DecisionCardBlockersEvidence,
  type DecisionCardAuthorityEvidence,
} from './schema';

const log = createLogger('kernel:decisions');

/** Open-vocabulary `source` this emitter raises on operator.approvals (#2152). */
export const DECISION_APPROVAL_SOURCE = 'decision';
/** `'<source>:<subkind>'` per #2152's namespaced-kind rule. */
export const DECISION_APPROVAL_KIND = 'decision:card';

/** Matches the notify boundary's own summary bound (`../notify/operator-approvals.ts`'s `MAX_SUMMARY_LENGTH`) — kept local since that constant isn't exported. */
const MAX_SUMMARY_LENGTH = 2000;

export type EmitDecisionCardResult =
  | { ok: true; proposalId: string; card: DecisionCard; prose: string }
  | { ok: false; error: string };

function fmtOptions(card: DecisionCard): string {
  return card.options.map((option) => `${option.letter}) ${option.label}`).join(' · ');
}

function fmtPr(evidence?: DecisionCardPrEvidence): string {
  if (!evidence) return '?';
  const mergeable = evidence.mergeable === null ? 'unknown' : evidence.mergeable ? 'mergeable' : 'conflict';
  return `#${evidence.number}(${evidence.draft ? 'draft' : 'ready'},${mergeable})`;
}

function fmtCi(evidence?: DecisionCardCiEvidence): string {
  return evidence ? evidence.conclusion : '?';
}

function fmtSonar(evidence?: DecisionCardSonarEvidence): string {
  if (!evidence) return '?';
  return `${evidence.qualityGate}(new:${evidence.newIssues})`;
}

function fmtReview(evidence?: DecisionCardReviewEvidence): string {
  return evidence ? evidence.verdict : '?';
}

function fmtRun(evidence?: DecisionCardRunEvidence): string {
  return evidence ? evidence.status : '?';
}

function fmtBlockers(evidence?: DecisionCardBlockersEvidence): string {
  if (!evidence) return '?';
  return `${evidence.blockedBy.length}blocked/${evidence.blocks.length}blocks`;
}

function fmtAuthority(evidence: DecisionCardAuthorityEvidence | undefined): string {
  return evidence ? (evidence.canActWithoutHuman ? 'auto' : 'human') : '?';
}

/**
 * Render the `ev:` line — EVERY evidence key appears, in a fixed order; a
 * key whose evidence is absent from the card renders `?` rather than being
 * dropped, so the line's shape never depends on which evidence happened to
 * be available (#2315 acceptance).
 */
export function renderDecisionCardEvidenceLine(evidence: DecisionCardEvidence): string {
  const parts = [
    `pr=${fmtPr(evidence.pr)}`,
    `ci=${fmtCi(evidence.ci)}`,
    `sonar=${fmtSonar(evidence.sonar)}`,
    `review=${fmtReview(evidence.review)}`,
    `run=${fmtRun(evidence.run)}`,
    `blockers=${fmtBlockers(evidence.blockers)}`,
    `authority=${fmtAuthority(evidence.authority)}`,
  ];
  return `ev: ${parts.join(' ')}`;
}

/**
 * Render the prose block: `DECISION · subject · question · a) … b) … c) …
 * · rec: <letter> — <why>`, with the `ev:` evidence line on its own
 * following line. This is what a NEEDS-DECISION renders as in chat/
 * Telegram today; the /jin Inbox card (#2288) renders the same object
 * differently, never a different source.
 */
export function renderDecisionCardProse(card: DecisionCard): string {
  const header = `DECISION · ${card.subject.ref} · ${card.question} · ${fmtOptions(card)} · rec: ${card.rec.letter} — ${card.rec.why}`;
  return `${header}\n${renderDecisionCardEvidenceLine(card.evidence)}`;
}

/**
 * Emit a DecisionCard: land it as a `kind: 'decision:card'` row on the
 * existing operator.approvals rail and return the prose render every
 * non-/jin surface shows today.
 *
 * `input` omits `id`/`createdAt`/`contentHash` — `./schema.ts`'s
 * `createDecisionCard` assigns those so every emit site gets the same
 * stable-hash guarantee for free. The card's own `id` is reused as the
 * approvals row's `proposalId` rather than minting a second identifier —
 * one card, one proposal.
 */
export async function emitDecisionCard(input: DecisionCardInput): Promise<EmitDecisionCardResult> {
  const built = createDecisionCard(input);
  if (!built.ok) return { ok: false, error: built.error };
  const { card } = built;

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    return { ok: false, error: 'No operator DID configured for this node — cannot raise a decision card' };
  }

  const prose = renderDecisionCardProse(card);
  const [headerLine] = prose.split('\n');
  const summary = headerLine.slice(0, MAX_SUMMARY_LENGTH);

  try {
    await recordApprovalRequested({
      proposalId: card.id,
      operatorDid,
      source: DECISION_APPROVAL_SOURCE,
      kind: DECISION_APPROVAL_KIND,
      summary,
      keysTouched: [],
      detail: card as unknown as Record<string, unknown>,
      contentHash: card.contentHash,
      notificationId: null,
      // #2337: raised in-process (never via the plugin's signed request
      // contract) — no separate requesting-agent DID to capture here.
      signerDid: null,
    });
  } catch (err) {
    log.error({ err: String(err), cardId: card.id }, 'Failed to record decision card');
    return { ok: false, error: 'Failed to record decision card' };
  }

  return { ok: true, proposalId: card.id, card, prose };
}
