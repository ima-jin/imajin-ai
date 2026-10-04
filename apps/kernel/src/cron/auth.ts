import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { resolveCronSecret } from './secret';

const log = createLogger('kernel');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Fail-closed `Authorization: Bearer <cron secret>` gate shared by every
 * `/api/cron/*` route and the cron status endpoint (#2550).
 *
 * The cron secret is a vault-generated internal secret (see `./secret.ts`),
 * not an env var. The routes used to guard with `if (cronSecret) { ...check... }`,
 * which meant an unset secret left them open to anyone. Now:
 *   - secret unavailable/empty   -> 503 (misconfigured; a WARN is logged)
 *   - missing or wrong bearer    -> 401
 *   - correct bearer             -> null (caller proceeds)
 *
 * Usage, first thing in the handler:
 *
 *   const denied = await requireCronAuth(request);
 *   if (denied) return denied;
 *
 * The secret and the presented header are never logged.
 */
export async function requireCronAuth(request: Request): Promise<NextResponse | null> {
  const cronSecret = await resolveCronSecret();
  if (!cronSecret) {
    log.warn(
      { path: new URL(request.url).pathname },
      'cron secret is not available from the vault — refusing cron request (fail closed)',
    );
    return NextResponse.json({ error: 'Cron authentication is not configured' }, { status: 503 });
  }

  const authHeader = request.headers.get('authorization') ?? '';
  if (!safeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
