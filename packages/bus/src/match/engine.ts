import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';
import { broker } from '../broker';
import { isBrokerRelease } from '../types';
import { publish } from '../publish';
import { findCandidates } from './candidates';
import { resolveReachRings, admitsUnderReach } from './reach';
import { intersectTags } from './intersect';
import { rankCandidates } from './rank';
import { recordMatch, getSpentIntents } from './records';
import { deliveryPolicy } from './deliver';
const log = createLogger('bus:match:engine');

/**
 * Match engine orchestrator.
 *
 * Registered as a ReactorHandler under the name 'match-engine' and wired to the
 * `availability.intent.created` event via bus_chain_configs. On every new availability
 * intent, this reactor runs the full bilateral match pipeline:
 *
 *   1. Parse arriver payload
 *   2. Fetch live candidate pool (SQL pre-filter)
 *   3. Resolve arriver's reach rings once (reused across all candidates)
 *   4. Per-candidate: mutual reach check → tag intersection → spend-check → rank
 *   5. For each surviving pair: broker('availability.match') for disclosure
 *   6. On release: determine delivery policy → emit availability.match.surfaced
 *
 * L1 TRIGGER  availability.intent.created
 *      │
 * L2 ENGINE   coordinator (this file) — search + set math + ranking + delivery
 *      │      for each surviving pair →
 *      ▼
 * L3 BROKER   consent → scope → release → audit (existing chain, reused)
 *
 * The engine can only NARROW — it rejects early but final disclosure decision
 * always goes through the broker chain (fail-closed preserved).
 */
export const matchEngineReactor: ReactorHandler = async (
  event: BusEvent,
  _config: Record<string, unknown>
): Promise<void> => {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  const intentId = typeof payload.intentId === 'string' ? payload.intentId : null;
  const arriverDid = typeof payload.did === 'string' ? payload.did : event.subject;
  const arriverReach = typeof payload.reach === 'string' ? payload.reach : 'favourites';
  const arriverTags: string[] = Array.isArray(payload.activityTags)
    ? (payload.activityTags as string[])
    : [];
  const arriverSensitiveTags: string[] = Array.isArray(payload.sensitiveTags)
    ? (payload.sensitiveTags as string[])
    : [];

  if (!intentId) {
    log.warn({ payload }, 'availability.intent.created missing intentId — skipping');
    return;
  }

  log.info(
    { intentId, arriverDid, arriverReach, tagCount: arriverTags.length },
    'Match engine triggered'
  );

  // Step 1: Fetch already-spent pairs to exclude from candidate scan.
  const spentIntentIds = await getSpentIntents(intentId);

  // Step 2: SQL pre-filter — cheap array-overlap (&&) to narrow the search space.
  const candidates = await findCandidates(intentId, arriverDid, arriverTags, spentIntentIds);

  if (candidates.length === 0) {
    log.info({ intentId, arriverDid }, 'No candidates — run complete (provable silence)');
    return;
  }

  // Step 3: Resolve arriver's reach rings once for the whole run.
  const arriverRings = await resolveReachRings(arriverDid);

  // Step 4: Per-candidate reach + intersection checks.
  interface SurvivingPair {
    candidateIntentId: string;
    candidateDid: string;
    candidateReach: string;
    overlapTags: string[];
    isSensitive: boolean;
    arriverAdmitsCandidate: boolean;
    candidateAdmitsArriver: boolean;
  }

  const survivingPairs: SurvivingPair[] = [];

  for (const candidate of candidates) {
    // Mutual reach: arriver's ring must admit candidate, and candidate's ring must admit arriver.
    const arriverAdmitsCandidate = admitsUnderReach(
      arriverReach,
      arriverDid,
      candidate.did,
      arriverRings
    );

    if (!arriverAdmitsCandidate) {
      log.info({ intentId, candidateIntentId: candidate.id }, 'Arriver reach rejects candidate');
      continue;
    }

    // Candidate's reach must admit the arriver. We need candidate's rings too.
    // Optimisation: for 'strangers' we can skip the DB lookup.
    let candidateAdmitsArriver: boolean;
    if (candidate.reach === 'strangers') {
      candidateAdmitsArriver = true;
    } else {
      const candidateRings = await resolveReachRings(candidate.did);
      candidateAdmitsArriver = admitsUnderReach(
        candidate.reach,
        candidate.did,
        arriverDid,
        candidateRings
      );
    }

    if (!candidateAdmitsArriver) {
      log.info({ intentId, candidateIntentId: candidate.id }, 'Candidate reach rejects arriver');
      continue;
    }

    // Tag intersection + OR-sensitivity.
    const { overlapTags, isSensitive } = intersectTags(
      arriverTags,
      arriverSensitiveTags,
      candidate.activityTags,
      candidate.sensitiveTags
    );

    if (overlapTags.length === 0) {
      log.info({ intentId, candidateIntentId: candidate.id }, 'No tag overlap — provable silence');
      continue;
    }

    survivingPairs.push({
      candidateIntentId: candidate.id,
      candidateDid: candidate.did,
      candidateReach: candidate.reach,
      overlapTags,
      isSensitive,
      arriverAdmitsCandidate,
      candidateAdmitsArriver,
    });
  }

  if (survivingPairs.length === 0) {
    log.info({ intentId, arriverDid }, 'All candidates rejected — run complete (provable silence)');
    return;
  }

  // Step 5: Rank survivors + cap at top 5.
  const rankedPairs = rankCandidates(
    survivingPairs.map((p) => ({
      id: p.candidateIntentId,
      did: p.candidateDid,
      activityTags: p.overlapTags,   // use overlap as rank proxy for shared tag count
      sensitiveTags: [],
      reach: p.candidateReach,
      startsAt: null,
      endsAt: null,
      expiresAt: null,
    })),
    arriverRings.oneDegreeSet
  ).map((r, i) => survivingPairs.find((p) => p.candidateIntentId === r.intent.id) ?? survivingPairs[i]);

  // Step 6: Per surviving pair — spend, broker, deliver.
  for (const pair of rankedPairs) {
    if (!pair) continue;

    // Spend-check: atomic insert-or-skip. Ensures a pair is never surfaced twice.
    const isNew = await recordMatch(intentId, pair.candidateIntentId, pair.overlapTags, pair.isSensitive);
    if (!isNew) {
      log.info({ intentId, candidateIntentId: pair.candidateIntentId }, 'Pair already spent — skipping');
      continue;
    }

    // Determine delivery policy before calling broker so it can be included in the envelope.
    const decision = deliveryPolicy(
      arriverReach,
      pair.candidateReach,
      arriverRings.favouritesSet,
      // Candidate's favourites set: use arriverRings as proxy for now (v2: resolve candidate rings above)
      new Set<string>(),
      pair.isSensitive,
      arriverDid,
      pair.candidateDid
    );

    // Broker call: routes through mutual-reach-consent → intersection-scope → release → audit.
    // The engine has already validated mutual reach; reactor flags are pre-computed to avoid
    // redundant DB calls inside the reactor.
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
      continue;
    }

    log.info(
      {
        intentId,
        candidateIntentId: pair.candidateIntentId,
        releaseId: brokerResult.envelope.releaseId,
        policy: decision.policy,
      },
      'Match disclosed'
    );

    const matchId = brokerResult.envelope.releaseId;

    // Deliver to arriver (always).
    publish('availability.match.surfaced', {
      issuer: arriverDid,
      subject: arriverDid,
      scope: 'calendar',
      payload: {
        matchId,
        recipientDid: arriverDid,
        otherDid: decision.policy === 'sensitive_staged' ? '' : pair.candidateDid,
        overlapTags: pair.overlapTags,
        isSensitive: pair.isSensitive,
        deliveryPolicy: decision.policy,
        context_id: matchId,
        context_type: 'calendar',
      },
    }).catch((err: unknown) =>
      log.error({ err: String(err), matchId }, 'availability.match.surfaced emit error (arriver)')
    );

    // Deliver to candidate if policy calls for it (named_nudge only).
    if (decision.notifyCandidate) {
      publish('availability.match.surfaced', {
        issuer: arriverDid,
        subject: pair.candidateDid,
        scope: 'calendar',
        payload: {
          matchId: `${matchId}:candidate`,
          recipientDid: pair.candidateDid,
          otherDid: arriverDid,
          overlapTags: pair.overlapTags,
          isSensitive: pair.isSensitive,
          deliveryPolicy: decision.policy,
          context_id: matchId,
          context_type: 'calendar',
        },
      }).catch((err: unknown) =>
        log.error({ err: String(err), matchId }, 'availability.match.surfaced emit error (candidate)')
      );
    }
  }

  log.info({ intentId, arriverDid, matches: rankedPairs.length }, 'Match engine run complete');
};
