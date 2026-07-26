import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';

/**
 * Dual-guard: tries app-auth (inference:read / inference:write) first; on
 * success resolves `ownerDid` from `X-Acting-For` (preferred) or
 * `appAuth.userDid` (fallback). On app-auth failure, falls through to the
 * existing user-session path.
 *
 * Returns `{ ownerDid }` on success or a ready-to-return `NextResponse` on
 * failure. Callers check `'ownerDid' in result` to distinguish the two shapes.
 *
 * Extracts the identical dual-guard block shared by all three inference routes
 * (#1431) — mirrors the pattern in `calendar/api/availability/[id]/route.ts`.
 */
export async function resolveInferenceOwnerDid(
  request: NextRequest,
  scope: 'inference:read' | 'inference:write',
  cors: Record<string, string>,
): Promise<{ ownerDid: string } | NextResponse> {
  const appAuthResult = await requireAppAuth(request, { scope });
  if ('appAuth' in appAuthResult) {
    const actingFor = request.headers.get('x-acting-for') ?? appAuthResult.appAuth.userDid;
    if (!actingFor) {
      return NextResponse.json(
        { error: 'X-Acting-For header (or delegating user) required for app auth' },
        { status: 400, headers: cors },
      );
    }
    return { ownerDid: actingFor };
  }
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  return { ownerDid: resolveActingDid(authResult.identity) };
}
