import type { BrokerReactor } from './types';

/**
 * Registry of named broker reactors.
 *
 * Mirrors the publish-side reactor registry (`registry.ts`) but for the
 * broker pipeline, whose reactors have a distinct signature (`BrokerReactor`:
 * they receive/return pipeline state rather than a bus event).
 *
 * Broker chain configs in `kernel.bus_chain_configs` reference reactors by
 * `type` name; this registry resolves those names to handlers so the broker
 * chain can be defined as pure data (config rows + named reactors) instead of
 * a hardcoded pipeline.
 */
const brokerReactors = new Map<string, BrokerReactor>();

export function registerBrokerReactor(type: string, handler: BrokerReactor): void {
  brokerReactors.set(type, handler);
}

export function getBrokerReactor(type: string): BrokerReactor | undefined {
  return brokerReactors.get(type);
}
