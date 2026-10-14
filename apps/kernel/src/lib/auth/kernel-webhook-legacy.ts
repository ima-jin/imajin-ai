/**
 * Temporary outbound compatibility for apps not yet verifying kernel signatures (#2798).
 *
 * Rollout started 2026-10-14. Remove this module and its optional Authorization header
 * when all per-app verifyKernelWebhook children of #2241 are closed.
 * See docs/security/kernel-webhooks.md. No variable here is required for delivery.
 * Stripe's inbound authentication is intentionally unrelated and unchanged.
 */
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const LEGACY_SECRET_VARS = {
  events: 'EVENTS_WEBHOOK_SECRET',
  market: 'MARKET_WEBHOOK_SECRET',
  learn: 'LEARN_WEBHOOK_SECRET',
  coffee: 'COFFEE_WEBHOOK_SECRET',
} as const;

export type LegacyWebhookApp = keyof typeof LEGACY_SECRET_VARS;
const warned = new Set<string>();

export function legacyWebhookHeaders(app: LegacyWebhookApp): Record<string, string> {
  const variable = LEGACY_SECRET_VARS[app];
  const secret = process.env[variable];
  if (!secret) return {};
  if (!warned.has(variable)) {
    warned.add(variable);
    log.warn({ variable }, 'Deprecated webhook bearer compatibility enabled; migrate app to kernel signature verification');
  }
  return { Authorization: `Bearer ${secret}` };
}
