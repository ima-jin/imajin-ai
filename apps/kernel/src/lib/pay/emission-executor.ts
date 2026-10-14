import { registerEmissionExecutor, getEmissionExecutor, type EmissionExecutor } from '@imajin/bus';
import { emitMjnx } from './emission-core';

/** Only kernel boot grants the bus access to the emission ledger. */
export const kernelEmissionExecutor: EmissionExecutor = (params) => emitMjnx(params);

export function ensureEmissionExecutorRegistered(): void {
  if (getEmissionExecutor() === kernelEmissionExecutor) return;
  registerEmissionExecutor(kernelEmissionExecutor);
}
