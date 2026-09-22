/**
 * POST /auth/api/agents/:did/reach — per-principal agent-reach endpoint (#2251).
 *
 * A foreign agent (already holding a did:imajin identity minted via the
 * existing, unmodified knock -> accept flow, #1883) asks whether `:did` — a
 * specific principal, e.g. Ryan — is open to being contacted about a
 * declared topic, on behalf of its own principal (e.g. Alice). Returns ONLY
 * a boolean answer, never the underlying gate data.
 *
 * No session/bearer auth on this route: the requester proves itself via a
 * request-body Ed25519 signature over the canonical transcript
 * (`reachTranscript`), verified against its own registered public key —
 * the same primitive challenge-response auth already uses. This lets a
 * foreign platform call this endpoint as a plain signed HTTP POST, without
 * first completing a separate session-auth round trip.
 *
 * Body: {
 *   requesterDid: string,
 *   onBehalfOf: { platform: string, externalRef: string, selfDescription?: string },
 *   purpose: string,      // e.g. 'agent.reach'
 *   field: string,        // e.g. 'contact_topics'
 *   predicate: 'contains' | 'overlaps' | 'is_empty' | 'eq' | 'gte' | 'lte',
 *   arg?: unknown,        // e.g. 'business_development'
 *   issuedAt: string,     // ISO 8601
 *   signature: string,    // hex Ed25519 over reachTranscript(did, { ...above })
 * }
 * Returns: { answer: boolean, transcriptHash: string, issuedAt: string }
 *
 * All authorization decisions fail closed and are logged via
 * `agent.reach.answered` / `agent.reach.denied` bus events (routed to the
 * `audit-log` reactor, migrations/0151_foreign_principal_stubs.sql).
 */
import { NextRequest, NextResponse } from 'next/server';
import { agentCardUrl } from '@/src/lib/http/node-url';
import { reachPrincipal, type ReachRequestInput } from '@/src/lib/auth/agent-reach';

function isReachOnBehalfOf(value: unknown): value is ReachRequestInput['onBehalfOf'] {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.platform === 'string' && v.platform.length > 0 && typeof v.externalRef === 'string' && v.externalRef.length > 0
    && (v.selfDescription === undefined || typeof v.selfDescription === 'string');
}

const KNOWN_PREDICATES = new Set(['contains', 'overlaps', 'is_empty', 'eq', 'gte', 'lte']);

function parseBody(body: Record<string, unknown>): { ok: true; input: ReachRequestInput } | { ok: false; error: string } {
  const { requesterDid, onBehalfOf, purpose, field, predicate, arg, issuedAt, signature } = body;

  if (typeof requesterDid !== 'string' || !requesterDid.startsWith('did:imajin:')) {
    return { ok: false, error: 'requesterDid must be a did:imajin DID' };
  }
  if (!isReachOnBehalfOf(onBehalfOf)) {
    return { ok: false, error: 'onBehalfOf must be { platform: string, externalRef: string, selfDescription?: string }' };
  }
  if (typeof purpose !== 'string' || !purpose) {
    return { ok: false, error: 'purpose is required' };
  }
  if (typeof field !== 'string' || !field) {
    return { ok: false, error: 'field is required' };
  }
  if (typeof predicate !== 'string' || !KNOWN_PREDICATES.has(predicate)) {
    return { ok: false, error: `predicate must be one of: ${[...KNOWN_PREDICATES].join(', ')}` };
  }
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    return { ok: false, error: 'issuedAt must be an ISO 8601 timestamp' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, error: 'signature is required' };
  }

  return {
    ok: true,
    input: {
      requesterDid,
      onBehalfOf,
      purpose,
      field,
      predicate: predicate as ReachRequestInput['predicate'],
      arg,
      issuedAt,
      signature,
    },
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ did: string }> }) {
  const { did } = await params;
  const principalDid = decodeURIComponent(did);
  if (!principalDid.startsWith('did:imajin:')) {
    return NextResponse.json({ error: 'Invalid principal DID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await reachPrincipal(principalDid, parsed.input);
  if ('denied' in result) {
    return NextResponse.json(
      { error: result.reason, onboarding: agentCardUrl() },
      { status: result.status },
    );
  }

  return NextResponse.json(result);
}
