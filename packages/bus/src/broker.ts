import { createLogger } from '@imajin/logger';
import type {
  BrokerEventType,
  BrokerReactor,
  BrokerRequest,
  BrokerResult,
  BrokerPipelineState,
  BrokerRejection,
} from './types';
import { consentReactor } from './reactors/consent';
import { scopeReactor } from './reactors/scope';
import { releaseReactor } from './reactors/release';
import { auditReactor, auditRejection } from './reactors/audit';
import { getBrokerChainConfig } from './config';
import { getBrokerReactor, registerBrokerReactor } from './broker-registry';

const log = createLogger('bus:broker');

/** A resolved pipeline step: the reactor and the config name it was resolved from. */
interface BrokerChainStep {
  type: string;
  reactor: BrokerReactor;
}

/**
 * Built-in broker reactors, registered by name so chain configs in
 * `kernel.bus_chain_configs` can reference them as pure data.
 */
registerBrokerReactor('consent', consentReactor);
registerBrokerReactor('scope', scopeReactor);
registerBrokerReactor('release', releaseReactor);
registerBrokerReactor('audit', auditReactor);

/**
 * Default broker pipeline, used when no chain config row exists for the
 * {eventType, scope} (or the DB is unreachable). Preserves the original
 * consent → scope → release → audit behavior.
 */
const DEFAULT_BROKER_CHAIN: readonly BrokerChainStep[] = [
  { type: 'consent', reactor: consentReactor },
  { type: 'scope', reactor: scopeReactor },
  { type: 'release', reactor: releaseReactor },
  { type: 'audit', reactor: auditReactor },
];

/** Reactor names skipped in preview mode (no envelope construction, no audit). */
const PREVIEW_SKIPPED_REACTORS = new Set(['release', 'audit']);

/**
 * Resolve the ordered broker pipeline for an event/scope.
 *
 * Reads the chain from `kernel.bus_chain_configs` (via {@link getBrokerChainConfig})
 * and maps each configured reactor name to a registered {@link BrokerReactor}.
 * Falls back to {@link DEFAULT_BROKER_CHAIN} when no usable config exists, so the
 * broker never runs an empty pipeline.
 */
async function resolveBrokerChain(
  eventType: string,
  scope: string
): Promise<readonly BrokerChainStep[]> {
  const config = await getBrokerChainConfig(eventType, scope);
  if (!config || config.reactors.length === 0) {
    return DEFAULT_BROKER_CHAIN;
  }

  const chain: BrokerChainStep[] = [];
  for (const rc of config.reactors) {
    if (!rc.enabled) continue;

    const reactor = getBrokerReactor(rc.type);
    if (!reactor) {
      log.warn({ reactor: rc.type, eventType, scope }, 'Unknown broker reactor type; skipping');
      continue;
    }

    chain.push({ type: rc.type, reactor });
  }

  if (chain.length === 0) {
    log.warn(
      { eventType, scope },
      'Chain config resolved to no usable reactors; using default broker chain'
    );
    return DEFAULT_BROKER_CHAIN;
  }

  return chain;
}

/**
 * Execute a consent-gated data release request.
 *
 * Pipeline: consent → scope → release → audit
 * - consent: resolves consent for {subject, requester, purpose}
 * - scope: filters data to only consented fields
 * - release: constructs the release envelope
 * - audit: fires a broker.release event via publish() (fire-and-forget)
 *
 * Preview mode: consent + scope run, release envelope + audit are skipped.
 * Returns what *would* be released with preview: true.
 *
 * Fail-closed: no consent → rejection. No bypass.
 *
 * @param type - broker event type
 * @param request - the release request
 * @returns BrokerRelease on success, BrokerRejection on failure
 */
export async function broker<T extends BrokerEventType>(
  type: T,
  request: BrokerRequest<T>
): Promise<BrokerResult> {
  log.info(
    { type, requester: request.requester, subject: request.subject, fields: request.fields, preview: request.preview },
    'Broker request received'
  );

  let state: BrokerPipelineState = { request };

  const chain = await resolveBrokerChain(type, request.scope);

  // Execute pipeline reactors in order
  for (const { type: reactorType, reactor } of chain) {
    // In preview mode, skip release and audit reactors
    if (request.preview && PREVIEW_SKIPPED_REACTORS.has(reactorType)) {
      log.info({ reactor: reactorType, preview: true }, 'Skipping reactor in preview mode');
      continue;
    }

    try {
      const result = await reactor(state);

      // If a reactor returns a rejection, short-circuit
      if (isRejection(result)) {
        log.warn(
          { reason: result.reason, reactor: reactorType },
          'Broker pipeline rejected'
        );

        // Fire audit for rejection (skipped in preview by auditRejection)
        await auditRejection(request, result);
        return result;
      }

      state = result;
    } catch (err) {
      log.error({ err: String(err), reactor: reactorType }, 'Broker reactor threw');

      const rejection: BrokerRejection = {
        status: 'rejected',
        reason: 'requester_unauthorized',
        fields: request.fields,
        details: `Reactor ${reactorType} threw: ${String(err)}`,
      };

      await auditRejection(request, rejection);
      return rejection;
    }
  }

  // Construct final release result
  if (!state.filteredData) {
    log.error({}, 'Broker pipeline completed without filtered data');

    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'requester_unauthorized',
      fields: request.fields,
      details: 'Pipeline completed but release data is incomplete',
    };

    await auditRejection(request, rejection);
    return rejection;
  }

  // Preview mode: return what would be released without envelope / audit
  if (request.preview) {
    const previewRelease = {
      status: 'released' as const,
      data: state.filteredData,
      envelope: {
        releaseId: 'preview',
        scopeId: request.scope,
        purpose: request.purpose,
        issuedAt: new Date().toISOString(),
        consentReference: state.consentReference || 'preview',
        mode: state.mode || 'attestation',
      },
      preview: true as const,
    };

    log.info({ preview: true }, 'Broker preview complete');
    return previewRelease;
  }

  if (!state.envelope) {
    log.error({}, 'Broker pipeline completed without envelope in non-preview mode');

    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'requester_unauthorized',
      fields: request.fields,
      details: 'Pipeline completed but envelope is missing',
    };

    await auditRejection(request, rejection);
    return rejection;
  }

  const release = {
    status: 'released' as const,
    data: state.filteredData,
    envelope: state.envelope,
  };

  log.info(
    { releaseId: release.envelope.releaseId },
    'Broker release complete'
  );

  return release;
}

/**
 * Type guard to check if a pipeline result is a rejection.
 */
function isRejection(
  value: BrokerPipelineState | BrokerRejection
): value is BrokerRejection {
  return 'status' in value && value.status === 'rejected';
}
