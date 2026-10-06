/**
 * Minimal in-process stand-in for `@imajin/bus` for the pay webhook route
 * suites (#2177).
 *
 * Those suites call the route's `POST` and assert on the DB writes and
 * follow-on bus publishes its handlers make. Since #2177 the route is only
 * ingress: it republishes the verified delivery as a `stripe.*` bus event and
 * the registered `pay-stripe` reactor does the handling. This helper keeps the
 * suites black-box by faithfully reproducing the two `publish()` behaviors the
 * relay depends on, without needing a DB for the chain-config lookup:
 *
 *  - a `stripe.*` publish runs the reactor the consumer registered under
 *    `pay-stripe` (and throws, like the real `publish()`, when none is
 *    registered);
 *  - a reactor that throws is caught and logged, never propagated — the real
 *    `publish()` swallows reactor errors, which is exactly why the relay
 *    reads the outcome back off its hand-off entry.
 *
 * Every other publish (`fee.rebate`, `payment_request.paid`, ...) is forwarded
 * untouched to the suite's own `publishMock`, so existing assertions on it are
 * unaffected. Not a `.test.ts` file, so it is not collected as a suite.
 *
 * Usage:
 *   vi.mock('@imajin/bus', async () =>
 *     (await import('@/src/lib/pay/__tests__/in-process-bus')).createInProcessBusMock(publishMock));
 */
import type { BusEvent, ReactorHandler } from '@imajin/bus';

type PublishEvent = Omit<BusEvent, 'type'>;

export function createInProcessBusMock(publishMock: (type: string, event: PublishEvent) => unknown) {
  const reactors = new Map<string, ReactorHandler>();

  return {
    registerReactor: (type: string, handler: ReactorHandler): void => {
      reactors.set(type, handler);
    },
    publish: async (type: string, event: PublishEvent): Promise<Record<string, never>> => {
      if (!type.startsWith('stripe.')) {
        await publishMock(type, event);
        return {};
      }
      const reactor = reactors.get('pay-stripe');
      if (!reactor) {
        throw new Error(`Unknown reactor(s) in chain for eventType=${type}: pay-stripe`);
      }
      try {
        await reactor({ ...event, type }, {});
      } catch {
        // Real publish() logs and swallows a throwing reactor.
      }
      return {};
    },
  };
}
