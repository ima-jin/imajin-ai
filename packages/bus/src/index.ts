import { registerReactor } from './registry';
import { attestationReactor } from './reactors/attestation';
import { emitReactor } from './reactors/emit';
import { notifyReactor } from './reactors/notify';
import { settleReactor } from './reactors/settle';

// Auto-register built-in reactors on import
registerReactor('attestation', attestationReactor);
registerReactor('emit', emitReactor);
registerReactor('notify', notifyReactor);
registerReactor('settle', settleReactor);

export { publish } from './publish';
export { registerReactor } from './registry';
export { getChainConfig } from './config';
export type { BusEvent, BusEventMap, BusEventType, ReactorConfig, ChainConfig, ReactorHandler } from './types';
