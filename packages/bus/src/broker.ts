import { createLogger } from '@imajin/logger';
import type {
  BrokerEventType,
  BrokerRequest,
  BrokerResult,
  BrokerPipelineState,
  BrokerRejection,
} from './types';
import { consentReactor } from './reactors/consent';
import { scopeReactor } from './reactors/scope';
import { releaseReactor } from './reactors/release';
import { auditReactor, auditRejection } from './reactors/audit';

const log = createLogger('bus:broker');

/**
 * Broker reactors executed in pipeline order.
 * Each reactor is sync/awaited and passes state to the next.
 */
const BROKER_CHAIN = [consentReactor, scopeReactor, releaseReactor, auditReactor];

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

  // Execute pipeline reactors in order
  for (const reactor of BROKER_CHAIN) {
    // In preview mode, skip release and audit reactors
    if (request.preview && (reactor === releaseReactor || reactor === auditReactor)) {
      log.info({ reactor: reactor.name, preview: true }, 'Skipping reactor in preview mode');
      continue;
    }

    try {
      const result = await reactor(state);

      // If a reactor returns a rejection, short-circuit
      if (isRejection(result)) {
        log.warn(
          { reason: result.reason, reactor: reactor.name },
          'Broker pipeline rejected'
        );

        // Fire audit for rejection (skipped in preview by auditRejection)
        await auditRejection(request, result);
        return result;
      }

      state = result;
    } catch (err) {
      log.error({ err: String(err), reactor: reactor.name }, 'Broker reactor threw');

      const rejection: BrokerRejection = {
        status: 'rejected',
        reason: 'requester_unauthorized',
        fields: request.fields,
        details: `Reactor ${reactor.name} threw: ${String(err)}`,
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
