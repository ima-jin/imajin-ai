import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';
import { broker } from '../broker';
import { isBrokerRelease } from '../types';
import { publish } from '../publish';
import { findCandidates } from './candidates';
import type { CandidateIntent } from './candidates';
import { resolveReachRings, admitsUnderReach } from './reach';
import type { ReachRings } from './reach';
import { intersectTags } from './intersect';
import { rankCandidates } from './rank';
import { recordMatch, getSpentIntents } from './records';
import { deliveryPolicy } from './deliver';
const log = createLogger('bus:match:engine');

interface SurvivingPair {
  candidateIntentId: string;
  candidateDid: string;
  candidateReach: string;
  overlapTags: string[];
  isSensitive: boolean;
  arriverAdmitsCandidate: boolean;
  candidateAdmitsArriver: boolean;
}

/** Emit an availability.match.surfaced event to a single recipient (fire-and-forget). */
function emitMatchSurfaced(
  issuerDid: string,
  recipientDid: string,
  otherDid: string,
  matchId: string,
  overlapTags: string[],
  isSensitive: boolean,
  policy: string
): void {
  publish('availability.match.surfaced', {
    issuer: issuerDid,
    subject: recipientDid,
    scope: 'calendar',
    payload: { matchId, recipientDid, otherDid, overlapTags, isSensitive, deliveryPolicy: policy, context_id: matchId, context_type: 'calendar' },
  }).catch((err: unknown) =>
    log.error({ err: String(err), matchId }, 'availability.match.surfaced emit error')
  );
}

/**
 * Evaluate a single candidate for mutual reach + tag intersection.
 * Returns a SurvivingPair if the candidate qualifies, null otherwise.
 */
async function evaluateCandidate(
  intentId: string,
  arriverDid: string,
  arriverReach: string,
  arriverTags: string[],
  arriverSensitiveTags: string[],
  arriverRings: ReachRings,
  candidate: CandidateIntent
): Promise<SurvivingPair | null> {
  const arriverAdmitsCandidate = admitsUnderReach(arriverReach, arriverDid, candidate.did, arriverRings);
  if (!arriverAdmitsCandidate) {
    log.info({ intentId, candidateIntentId: candidate.id }, 'Arriver reach rejects candidate');
    return null;
  }

  let candidateAdmitsArriver: boolean;
  if (candidate.reach === 'strangers') {
    candidateAdmitsArriver = true;
  } else {
    const candidateRings = await resolveReachRings(candidate.did);
    candidateAdmitsArriver = admitsUnderReach(candidate.reach, candidate.did, arriverDid, candidateRings);
  }

  if (!candidateAdmitsArriver) {
    log.info({ intentId, candidateIntentId: candidate.id }, 'Candidate reach rejects arriver');
    return null;
  }

  const { overlapTags, isSensitive } = intersectTags(
    arriverTags, arriverSensitiveTags, candidate.activityTags, candidate.sensitiveTags
  );
  if (overlapTags.length === 0) {
    log.info({ intentId, candidateIntentId: candidate.id }, 'No tag overlap — provable silence');
    return null;
  }

  return { candidateIntentId: candidate.id, candidateDid: candidate.did, candidateReach: candidate.reach, overlapTags, isSensitive, arriverAdmitsCandidate, candidateAdmitsArriver };
}

/**
 * Spend, disclose via broker, and deliver a single surviving pair.
 * Returns true if the pair was newly disclosed, false if already spent or rejected.
 */
async function disclosePair(
  intentId: string,
  arriverDid: string,
  arriverReach: string,
  arriverFavourites: Set<string>,
  pair: SurvivingPair
): Promise<boolean> {
  const isNew = await recordMatch(intentId, pair.candidateIntentId, pair.overlapTags, pair.isSensitive);
  if (!isNew) {
    log.info({ intentId, candidateIntentId: pair.candidateIntentId }, 'Pair already spent — skipping');
    return false;
  }

  const decision = deliveryPolicy(
    arriverReach, pair.candidateReach, arriverFavourites,
    new Set<string>(), pair.isSensitive, arriverDid, pair.candidateDid
  );

  const brokerResult = await broker('availability.match', {
    type: 'availability.match',
    requester: arriverDid,
    subject: pair.candidateDid,
    fields: ['overlap_tags'],
    purpose: 'availability.match',
    scope: 'calendar',
    data: {
      arriverIntentId: intentId,
      candidateIntentId: pair.candidateIntentId,
      overlapTags: pair.overlapTags,
      isSensitive: pair.isSensitive,
      deliveryPolicy: decision.policy,
      arriverAdmitsCandidate: pair.arriverAdmitsCandidate,
      candidateAdmitsArriver: pair.candidateAdmitsArriver,
    },
  });

  if (!isBrokerRelease(brokerResult)) {
    log.warn(
      { intentId, candidateIntentId: pair.candidateIntentId, reason: brokerResult.reason },
      'Broker rejected availability.match — no disclosure'
    );
    return false;
  }

  const matchId = brokerResult.envelope.releaseId;
  log.info({ intentId, candidateIntentId: pair.candidateIntentId, releaseId: matchId, policy: decision.policy }, 'Match disclosed');

  const otherForArriver = decision.policy === 'sensitive_staged' ? '' : pair.candidateDid;
  emitMatchSurfaced(arriverDid, arriverDid, otherForArriver, matchId, pair.overlapTags, pair.isSensitive, decision.policy);

  if (decision.notifyCandidate) {
    emitMatchSurfaced(arriverDid, pair.candidateDid, arriverDid, `${matchId}:candidate`, pair.overlapTags, pair.isSensitive, decision.policy);
  }
  return true;
}

/**
 * Match engine orchestrator.
 *
 * Registered as a ReactorHandler under the name 'match-engine' and wired to the
 * `availability.intent.created` event via bus_chain_configs.
 *
 * L1 TRIGGER  availability.intent.created
 *      │
 * L2 ENGINE   coordinator — search + set math + ranking + delivery
 *      │      for each surviving pair →
 *      ▼
 * L3 BROKER   consent → scope → release → audit (existing chain, reused)
 *
 * The engine can only NARROW — final disclosure always goes through the broker chain.
 */
export const matchEngineReactor: ReactorHandler = async (
  event: BusEvent,
  _config: Record<string, unknown>
): Promise<void> => {
  const payload: Record<string, unknown> = event.payload ?? {};
  const intentId = typeof payload.intentId === 'string' ? payload.intentId : null;
  const arriverDid = typeof payload.did === 'string' ? payload.did : event.subject;
  const arriverReach = typeof payload.reach === 'string' ? payload.reach : 'favourites';
  const arriverTags: string[] = Array.isArray(payload.activityTags) ? (payload.activityTags as string[]) : [];
  const arriverSensitiveTags: string[] = Array.isArray(payload.sensitiveTags) ? (payload.sensitiveTags as string[]) : [];

  if (!intentId) {
    log.warn({ payload }, 'availability.intent.created missing intentId — skipping');
    return;
  }

  log.info({ intentId, arriverDid, arriverReach, tagCount: arriverTags.length }, 'Match engine triggered');

  const spentIntentIds = await getSpentIntents(intentId);
  const candidates = await findCandidates(intentId, arriverDid, arriverTags, spentIntentIds);

  if (candidates.length === 0) {
    log.info({ intentId, arriverDid }, 'No candidates — run complete (provable silence)');
    return;
  }

  const arriverRings = await resolveReachRings(arriverDid);

  const survivingPairs: SurvivingPair[] = [];
  for (const candidate of candidates) {
    const pair = await evaluateCandidate(intentId, arriverDid, arriverReach, arriverTags, arriverSensitiveTags, arriverRings, candidate);
    if (pair) survivingPairs.push(pair);
  }

  if (survivingPairs.length === 0) {
    log.info({ intentId, arriverDid }, 'All candidates rejected — run complete (provable silence)');
    return;
  }

  const rankedPairs = rankCandidates(
    survivingPairs.map((p) => ({ id: p.candidateIntentId, did: p.candidateDid, activityTags: p.overlapTags, sensitiveTags: [], reach: p.candidateReach, startsAt: null, endsAt: null, expiresAt: null })),
    arriverRings.oneDegreeSet
  ).map((r, i) => survivingPairs.find((p) => p.candidateIntentId === r.intent.id) ?? survivingPairs[i]);

  let disclosed = 0;
  for (const pair of rankedPairs) {
    if (pair && await disclosePair(intentId, arriverDid, arriverReach, arriverRings.favouritesSet, pair)) {
      disclosed++;
    }
  }

  log.info({ intentId, arriverDid, disclosed }, 'Match engine run complete');
};
