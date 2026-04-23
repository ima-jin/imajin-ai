import { registerReactor } from './registry';
import { attestationReactor } from './reactors/attestation';
import { dfosReactor } from './reactors/dfos';
import { emitReactor } from './reactors/emit';
import { mjnReactor } from './reactors/mjn';
import { notifyReactor } from './reactors/notify';
import { settleReactor } from './reactors/settle';
import { webhookReactor } from './reactors/webhook';

// Auto-register built-in reactors on import
registerReactor('attestation', attestationReactor);
registerReactor('dfos', dfosReactor);
registerReactor('emit', emitReactor);
registerReactor('mjn', mjnReactor);
registerReactor('notify', notifyReactor);
registerReactor('settle', settleReactor);
registerReactor('webhook', webhookReactor);

export { publish } from './publish';
export { registerReactor } from './registry';
export { getChainConfig } from './config';
export type { BusEvent, BusEventMap, BusEventType, ReactorConfig, ChainConfig, ReactorHandler } from './types';
