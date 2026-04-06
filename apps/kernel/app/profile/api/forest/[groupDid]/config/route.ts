import { NextRequest, NextResponse } from 'next/server';
import { db, forestConfig, groupControllers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { SERVICES } from '@imajin/config';

const VALID_SERVICE_NAMES = new Set(SERVICES.map((s) => s.name));

/**
 * Verify caller is a controller of the group with the given minimum role.
 */
async function verifyController(
  groupDid: string,
  callerDid: string,
  minRole: 'member' | 'admin' | 'owner' = 'member'
): Promise<{ valid: boolean; role?: string }> {
  try {
    const [membership] = await db
      .select({ role: groupControllers.role })
      .from(groupControllers)
      .where(
        and(
          eq(groupControllers.groupDid, groupDid),
          eq(groupControllers.controllerDid, callerDid),
          isNull(groupControllers.removedAt)
        )
      )
      .limit(1);

    if (!membership) return { valid: false };

    const roleHierarchy = ['member', 'admin', 'owner'];
    const callerLevel = roleHierarchy.indexOf(membership.role);
    const minLevel = roleHierarchy.indexOf(minRole);
    return { valid: callerLevel >= minLevel, role: membership.role };
  } catch {
    return { valid: false };
  }
}

/**
 * GET /api/forest/[groupDid]/config
 * Get forest config. Caller must be an active controller.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid } = await params;

  const ctrl = await verifyController(groupDid, caller.id);
  if (!ctrl.valid) {
    return NextResponse.json({ error: 'Not a controller of this group' }, { status: 403 });
  }

  const [config] = await db
    .select()
    .from(forestConfig)
    .where(eq(forestConfig.groupDid, groupDid))
    .limit(1);

  return NextResponse.json(config ?? { enabledServices: [], landingService: null, theme: {} });
}

/**
 * PATCH /api/forest/[groupDid]/config
 * Update forest config. Caller must be owner or admin.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid } = await params;

  const ctrl = await verifyController(groupDid, caller.id, 'admin');
  if (!ctrl.valid) {
    return NextResponse.json({ error: 'Must be owner or admin' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { enabledServices, landingService, theme } = body as {
    enabledServices?: string[];
    landingService?: string | null;
    theme?: Record<string, unknown>;
  };

  if (enabledServices !== undefined) {
    if (!Array.isArray(enabledServices)) {
      return NextResponse.json({ error: 'enabledServices must be an array' }, { status: 400 });
    }
    const invalid = enabledServices.filter((n) => !VALID_SERVICE_NAMES.has(n));
    if (invalid.length > 0) {
      return NextResponse.json({ error: `Unknown services: ${invalid.join(', ')}` }, { status: 400 });
    }
    if (landingService && !enabledServices.includes(landingService)) {
      return NextResponse.json({ error: 'landingService must be in enabledServices' }, { status: 400 });
    }
  }

  const now = new Date();
  const updateSet: Record<string, unknown> = { updatedAt: now };
  if (enabledServices !== undefined) updateSet.enabledServices = enabledServices;
  if (landingService !== undefined) updateSet.landingService = landingService;
  if (theme !== undefined) updateSet.theme = theme;

  await db
    .insert(forestConfig)
    .values({
      groupDid,
      enabledServices: enabledServices ?? [],
      landingService: landingService ?? null,
      theme: theme ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: forestConfig.groupDid,
      set: updateSet,
    });

  return NextResponse.json({ ok: true });
}
