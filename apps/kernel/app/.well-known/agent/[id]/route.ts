import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { nodeUrl, agentCardUrl } from '@/src/lib/http/node-url';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /.well-known/agent/:id — per-principal agent card (#2251).
 *
 * Resolves a human's DID or handle to the reach endpoint a foreign agent
 * uses to ask that principal's gate a single question. Reuses the same
 * identity-resolution shape as `GET /api/lookup/:id`
 * (apps/kernel/app/auth/api/lookup/[id]/route.ts) rather than inventing a
 * second one, and points at the same knock-based onboarding flow the
 * platform-wide agent card (`/.well-known/agent.json`, #966) already
 * advertises — a foreign agent with no identity yet is told to knock first,
 * exactly like every other 401/403 onboarding pointer.
 *
 * This is deliberately NOT a second protocol surface: it is a discovery
 * document, kernel-routed (#2251 Phase 1 answer to open question (a)),
 * pointing at the one new action route this slice adds,
 * `POST /auth/api/agents/:did/reach`.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rawId = decodeURIComponent(id);
    const column = rawId.startsWith('did:imajin:') ? identities.id : identities.handle;

    const [identity] = await db
      .select({ id: identities.id, handle: identities.handle, name: identities.name })
      .from(identities)
      .where(eq(column, rawId))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Principal not found', onboarding: agentCardUrl() },
        { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    const node = nodeUrl();
    const card = {
      schemaVersion: '0.1',
      principalDid: identity.id,
      handle: identity.handle,
      name: identity.name,
      reach: {
        endpoint: `${node}/auth/api/agents/${encodeURIComponent(identity.id)}/reach`,
        protocol: 'imajin-agent-reach/0.1',
        description:
          'Signed reach request under a principal-authored gate. Returns only a boolean answer — never the underlying data. Requires an active agent:reach delegation grant from this principal.',
      },
      authentication: {
        schemes: ['did-imajin'],
      },
      onboarding: {
        flow: 'knock',
        endpoint: `${node}/auth/api/knock`,
        flowDocument: `${node}/.well-known/imajin-onboarding.json`,
        description:
          'A foreign agent with no did:imajin identity yet must knock (declaring this principal as the target) and be accepted before it can hold an agent:reach grant.',
      },
    };

    return NextResponse.json(card, {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, '[.well-known/agent] Error resolving principal agent card');
    return NextResponse.json(
      { error: 'Failed to resolve principal agent card' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}
