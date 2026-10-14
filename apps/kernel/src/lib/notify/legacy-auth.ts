import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const LEGACY_NOTIFY_WARNING = Symbol.for('@imajin/kernel/legacy-notify-auth-warning');
const globalState = globalThis as { [LEGACY_NOTIFY_WARNING]?: boolean };

/**
 * Temporary notify-only rollout bridge (#2798, 2026-10-14). Remove after
 * all per-app verify children of #2241 are closed; unset the variable
 * to disable immediately. Never use for registry/contact/internal approvals.
 */
export function acceptsLegacyNotifyCredential(request: Pick<NextRequest, 'headers'>): boolean {
  if (request.headers.has('authorization')) return false;
  const expected = process.env.NOTIFY_WEBHOOK_SECRET;
  const received = request.headers.get('x-webhook-secret');
  if (!expected || !received) return false;
  const actualBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return false;
  if (!globalState[LEGACY_NOTIFY_WARNING]) {
    globalState[LEGACY_NOTIFY_WARNING] = true;
    log.warn({}, 'Legacy notify shared-secret authentication is deprecated (#2798, 2026-10-14); migrate callers to operator-approved app-service tokens and unset the notify webhook secret');
  }
  return true;
}
