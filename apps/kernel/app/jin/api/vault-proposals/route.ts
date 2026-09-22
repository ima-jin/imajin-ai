/**
 * POST /jin/api/vault-proposals — raise a vault:* proposal on the EXISTING
 * operator-approvals rail (#2247; the rail itself is #2059/#2152).
 *
 * This is the canvas-native counterpart to an agent proposing in chat via
 * `POST /notify/api/send` (webhook-secret-gated, meant for external
 * plugins/services). The /jin UI itself needs a session-authenticated way
 * to raise the SAME shape of proposal, so this route calls
 * `recordApprovalRequested` directly, in-process — no self-HTTP-call,
 * matching the precedent already established by `sealAndStore` and friends
 * ("callable in-process from any tool handler").
 *
 * Only the node operator may raise a vault proposal from the canvas — same
 * gate as `POST /jin/api/operator-approvals/:id/decision` — since "chat
 * proposes" already covers the agent-authored path.
 *
 * Approving the resulting card (via the pre-existing decision route) is
 * the actual signing event; the vault mutation itself runs in
 * `src/lib/vault/approvals-execution.ts`, invoked by that route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { revokeTierLabel } from '@/src/lib/vault/revoke-tier';

const log = createLogger('kernel:vault-proposals');

export const dynamic = 'force-dynamic';

const VAULT_PROPOSAL_KINDS = new Set(['mint', 'grant', 'rotate', 'revoke']);
const REVOKE_TIERS = new Set(['withdraw', 'tombstone', 'destroy']);
const MAX_PURPOSE_LENGTH = 200;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface VaultProposalBody {
  kind?: unknown;
  detail?: unknown;
}

type ValidationResult = { ok: true; summary: string; keysTouched: string[] } | { ok: false; error: string };

function isNonEmptyString(value: unknown, maxLength = 2000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validateMintDetail(detail: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(detail.purpose, MAX_PURPOSE_LENGTH)) {
    return { ok: false, error: 'detail.purpose is required (max 200 chars)' };
  }
  if (!isNonEmptyString(detail.requesterDid)) {
    return { ok: false, error: 'detail.requesterDid is required' };
  }
  const purpose = detail.purpose as string;
  const requesterDid = detail.requesterDid as string;
  return {
    ok: true,
    summary: `Mint a new vault-native service key for "${purpose}", delivered to ${requesterDid}.`,
    keysTouched: [],
  };
}

function validateGrantDetail(detail: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(detail.did)) {
    return { ok: false, error: 'detail.did is required' };
  }
  if (!isNonEmptyString(detail.grantedTo)) {
    return { ok: false, error: 'detail.grantedTo is required' };
  }
  if (detail.oneTime !== undefined && typeof detail.oneTime !== 'boolean') {
    return { ok: false, error: 'detail.oneTime must be a boolean' };
  }
  const did = detail.did as string;
  const grantedTo = detail.grantedTo as string;
  return {
    ok: true,
    summary: `Grant ${grantedTo} access to the vault key ${did}.`,
    keysTouched: [did],
  };
}

function validateRotateDetail(detail: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(detail.did)) {
    return { ok: false, error: 'detail.did is required' };
  }
  const did = detail.did as string;
  return {
    ok: true,
    summary: `Rotate the vault key ${did}: mint a replacement, grant its current consumer, then revoke the old key.`,
    keysTouched: [did],
  };
}

function validateRevokeDetail(detail: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(detail.did)) {
    return { ok: false, error: 'detail.did is required' };
  }
  if (detail.tier !== undefined && (typeof detail.tier !== 'string' || !REVOKE_TIERS.has(detail.tier))) {
    return { ok: false, error: "detail.tier must be one of 'withdraw', 'tombstone', 'destroy'" };
  }
  const did = detail.did as string;
  const tier = (detail.tier as string | undefined) ?? 'withdraw';
  return {
    ok: true,
    summary: `${revokeTierLabel(tier)} the vault key ${did}.`,
    keysTouched: [did],
  };
}

/** Per-kind detail validation, split out so POST stays under the cognitive-complexity budget. */
function validateDetailForKind(kind: string, detail: Record<string, unknown>): ValidationResult {
  switch (kind) {
    case 'mint':
      return validateMintDetail(detail);
    case 'grant':
      return validateGrantDetail(detail);
    case 'rotate':
      return validateRotateDetail(detail);
    case 'revoke':
      return validateRevokeDetail(detail);
    default:
      return { ok: false, error: `Unsupported vault proposal kind '${kind}'` };
  }
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return NextResponse.json({ error: 'Only the node operator may raise a vault proposal' }, { status: 403, headers: cors });
  }

  let body: VaultProposalBody;
  try {
    body = (await request.json()) as VaultProposalBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { kind } = body;
  if (typeof kind !== 'string' || !VAULT_PROPOSAL_KINDS.has(kind)) {
    return NextResponse.json(
      { error: "kind must be one of 'mint', 'grant', 'rotate', 'revoke'" },
      { status: 400, headers: cors },
    );
  }

  const detail = (typeof body.detail === 'object' && body.detail !== null && !Array.isArray(body.detail))
    ? (body.detail as Record<string, unknown>)
    : {};

  const validation = validateDetailForKind(kind, detail);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }

  const proposalId = generateId('vprop');
  const source = 'vault';
  const proposalKind = `vault:${kind}`;
  const { summary, keysTouched } = validation;

  const contentHash = computeApprovalContentHash({
    proposalId,
    source,
    kind: proposalKind,
    summary,
    keysTouched,
    detail,
  });

  try {
    await recordApprovalRequested({
      proposalId,
      operatorDid,
      source,
      kind: proposalKind,
      summary,
      keysTouched,
      detail,
      contentHash,
      notificationId: null,
    });
    return NextResponse.json({ proposalId }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), kind: proposalKind, operatorDid }, 'Failed to record vault proposal');
    return NextResponse.json({ error: 'Failed to raise vault proposal' }, { status: 500, headers: cors });
  }
}
