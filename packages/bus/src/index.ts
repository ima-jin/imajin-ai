import { registerReactor } from './registry';
import { attestationReactor } from './reactors/attestation';
import { attestationNotifyReactor } from './reactors/attestation-notify';
import { auditLogReactor } from './reactors/audit-log';
import { dfosReactor } from './reactors/dfos';
import { emitReactor } from './reactors/emit';
import { mjnReactor } from './reactors/mjn';
import { notifyReactor } from './reactors/notify';
import { settleReactor } from './reactors/settle';
import { webhookReactor } from './reactors/webhook';
import { matchEngineReactor } from './match/engine';
import { notifyMatchDeliveryReactor } from './reactors/notify-match-delivery';
import { supplyRecorderReactor } from './reactors/supply-recorder';
import { brokerPredicateInvalidationReactor } from './reactors/broker-predicate-invalidation';

// Auto-register built-in reactors on import
registerReactor('attestation', attestationReactor);
registerReactor('attestation-notify', attestationNotifyReactor);
registerReactor('audit-log', auditLogReactor);
registerReactor('dfos', dfosReactor);
registerReactor('emit', emitReactor);
registerReactor('mjn', mjnReactor);
registerReactor('notify', notifyReactor);
registerReactor('settle', settleReactor);
registerReactor('webhook', webhookReactor);
registerReactor('match-engine', matchEngineReactor);
registerReactor('notify-match-delivery', notifyMatchDeliveryReactor);
registerReactor('supply-recorder', supplyRecorderReactor);
registerReactor('broker-predicate-invalidation', brokerPredicateInvalidationReactor);

export { publish } from './publish';
export { broker } from './broker';
export { registerReactor } from './registry';
export { registerBrokerReactor, getBrokerReactor } from './broker-registry';
export { getChainConfig, getBrokerChainConfig } from './config';
export { getLotChain, recentLotsBySupplier } from './supply-lots';
export { EMISSION_SCHEDULE } from './emissions';
export { resolveConsent } from './broker-config';
export { isBrokerRelease, isBrokerRejection } from './types';
// Match engine broker reactors — registered in broker.ts alongside the core four.
export { mutualReachConsentReactor } from './reactors/mutual-reach-consent';
export { intersectionScopeReactor } from './reactors/intersection-scope';
export type {
  BusEvent,
  BusEventMap,
  BusEventType,
  ReactorConfig,
  ChainConfig,
  ReactorHandler,
  BrokerRequest,
  BrokerFieldReleaseMode,
  BrokerReleaseEnvelopeMode,
  BrokerResolvedFieldGrant,
  BrokerPredicateRequest,
  BrokerPredicateClaim,
  BrokerRelease,
  BrokerRejection,
  BrokerRejectionReason,
  BrokerResult,
  BrokerPipelineState,
  BrokerReactor,
  BrokerEventType,
} from './types';
export type { ConsentEntry } from './broker-config';
export type { LotChain, SupplyLotRecord, SupplyStageRecord, RecentLot } from './supply-lots';
