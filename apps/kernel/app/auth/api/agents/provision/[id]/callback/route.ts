import { NextRequest, NextResponse } from 'next/server';
import { recordBootStatus } from '@/src/lib/auth/agent-provisioner';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * POST /auth/api/agents/provision/[id]/callback
 *
 * Boot-status callback the operator-run runner (`packages/claw-provisioner`)
 * calls after materializing/starting a `placement: 'hosted'` stack (#1933
 * deliverable 2). The runner is an operator-executed script with no
 * agent/session identity of its own in v0, so this route authenticates it
 * with a shared secret rather than `requireAuth` — a deliberate v0
 * simplification, documented in `docs/agents/envelope-provisioner.md`, not
 * a general kernel authentication primitive. A future iteration should
 * replace this with a proper app-token/attestation-based callback.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const expectedToken = process.env.PROVISIONER_RUNNER_TOKEN;
  if (!expectedToken) {
    log.error({}, '[agents/provision/callback] PROVISIONER_RUNNER_TOKEN not configured — refusing all callbacks');
    return NextResponse.json({ error: 'Runner callback is not configured on this node' }, { status: 503 });
  }
  const providedToken = request.headers.get('x-provisioner-runner-token');
  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: 'Invalid or missing runner token' }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { status, detail } = body as { status?: string; detail?: string };
  if (status !== 'booted' && status !== 'failed') {
    return NextResponse.json({ error: "status must be 'booted' or 'failed'" }, { status: 400 });
  }

  try {
    const provision = await recordBootStatus(id, status, detail);
    if (!provision) {
      return NextResponse.json({ error: 'Provision not found' }, { status: 404 });
    }
    return NextResponse.json({ provision });
  } catch (error) {
    log.error({ err: String(error) }, '[agents/provision/callback] Error');
    return NextResponse.json({ error: 'Failed to record boot status' }, { status: 500 });
  }
}
