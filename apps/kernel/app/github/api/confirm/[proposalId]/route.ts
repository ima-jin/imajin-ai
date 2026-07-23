/**
 * POST /github/api/confirm/:proposalId
 *
 * The human approval tap for a pending GitHub mutate-write proposal (#1366).
 *
 * Advances a proposal from 'pending' → 'approved', records a signed
 * ownerAuthorization, and publishes action.approved so the /jin dashboard
 * can update its pending-proposals view.
 *
 * Body (JSON):
 *   { ttl?: 'single' | '5m' | '24h' }   — defaults to 'single'
 *
 * Response:
 *   { proposalId, status: 'approved', approvedUntil: string | null }
 *
 * Mirrors the inference confirm route (app/api/inference/confirm/[sessionId]/route.ts)
 * and reuses the same node-signing pattern established by #1293.
 */
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid, canonicalize, crypto as authCrypto } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, githubActionProposals } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import * as bus from '@imajin/bus';

const log = createLogger('kernel:github:confirm-route');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

const TTL_OPTIONS = new Set(['single', '5m', '24h'] as const);
type TtlOption = 'single' | '5m' | '24h';

function resolveApprovedUntil(ttl: TtlOption): Date | null {
  if (ttl === 'single') return null;
  const ms = ttl === '5m' ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { proposalId: string } },
) {
  const cors = corsHeaders(request);
  const { proposalId } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  try {
    // ── Load + validate the proposal ──────────────────────────────────────────
    const [proposal] = await db
      .select()
      .from(githubActionProposals)
      .where(
        and(
          eq(githubActionProposals.id, proposalId),
          eq(githubActionProposals.ownerDid, ownerDid),
        ),
      )
      .limit(1);

    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404, headers: cors });
    }
    if (proposal.status !== 'pending') {
      return NextResponse.json(
        { error: `Proposal is not awaiting confirmation (status: ${proposal.status})` },
        { status: 400, headers: cors },
      );
    }

    // ── Parse TTL from body ───────────────────────────────────────────────────
    let ttl: TtlOption = 'single';
    try {
      const body = await request.json() as Record<string, unknown>;
      const rawTtl = body.ttl;
      if (typeof rawTtl === 'string' && TTL_OPTIONS.has(rawTtl as TtlOption)) {
        ttl = rawTtl as TtlOption;
      }
    } catch {
      // Missing or non-JSON body → default to 'single'
    }

    const approvedUntil = resolveApprovedUntil(ttl);

    // ── Sign the owner authorization (mirrors #1293 confirmIntent pattern) ────
    const identity = getNodeSigningIdentity();
    const ts = new Date().toISOString();
    const authPayload = {
      proposalId,
      ownerDid,
      tool: proposal.tool,
      target: proposal.target,
      ttl,
      ts,
    };
    // Derive a content digest of the proposal args so the approval is bound to
    // the exact proposed action.
    const argsDigest = createHash('sha256')
      .update(proposal.argsSummary)
      .digest('hex');
    const signingPayload = { ...authPayload, argsDigest };
    const authSignature = authCrypto.signSync(canonicalize(signingPayload), identity.privateKeyHex);
    const ownerAuthorization = {
      payload: signingPayload,
      signature: authSignature,
      senderPubkey: identity.senderPubkey,
    };

    // ── Persist: pending → approved ──────────────────────────────────────────
    await db
      .update(githubActionProposals)
      .set({
        status: 'approved',
        approvedUntil,
        ownerAuthorization,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(githubActionProposals.id, proposalId),
          eq(githubActionProposals.ownerDid, ownerDid),
        ),
      );

    // ── Publish action.approved (non-fatal) ───────────────────────────────────
    try {
      await bus.publish('action.approved', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'github',
        payload: {
          proposalId,
          ownerDid,
          tool: proposal.tool,
          target: proposal.target,
          approvedUntil: approvedUntil?.toISOString() ?? null,
          ownerAuthorization,
          context_id: proposalId,
          context_type: 'github' as const,
        },
      });
    } catch (err) {
      log.error({ err: String(err), proposalId }, 'action.approved publish failed (non-fatal)');
    }

    log.info(
      { proposalId, ownerDid, tool: proposal.tool, target: proposal.target, ttl },
      'proposal approved',
    );

    return NextResponse.json(
      {
        proposalId,
        status: 'approved',
        tool: proposal.tool,
        target: proposal.target,
        approvedUntil: approvedUntil?.toISOString() ?? null,
        message: ttl === 'single'
          ? 'Single-call approval granted. Retry the tool call to execute.'
          : `Windowed approval granted until ${approvedUntil!.toISOString()}. Any mutate call within this window will execute without re-prompting.`,
      },
      { status: 200, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), proposalId, ownerDid }, 'Confirm failed');
    return NextResponse.json({ error: String(err) }, { status: 400, headers: cors });
  }
}
