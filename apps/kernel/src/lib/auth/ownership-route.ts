import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, type Identity } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { ownershipTransfer } from './ownership-transfer';
import { OwnershipError } from './ownership-policy';

const log = createLogger('kernel');
export type OwnershipParams = { params: Promise<{ groupDid: string }> };
type Operation = Parameters<typeof ownershipTransfer>[2];

function parseInput(body: unknown, operation: Operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OwnershipError('Expected JSON object', 400);
  }
  const key = operation === 'propose' ? 'newOwnerDid' : 'transferId';
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new OwnershipError(`${key} required`, 400);
  }
  return { [key]: value.trim() };
}

export async function handleOwnershipRoute(
  request: NextRequest, params: OwnershipParams, operation: Operation,
  gate?: (identity: Identity, resourceId: string, headers: HeadersInit) => Response | null,
) {
  const headers = corsHeaders(request);
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  const { groupDid } = await params.params;
  if (gate) {
    const denied = gate(auth.identity, groupDid, headers);
    if (denied) return denied;
  }
  try {
    let body: unknown = {};
    if (operation !== 'read') {
      try { body = await request.json(); }
      catch { throw new OwnershipError('Invalid JSON', 400); }
    }
    const input = operation === 'read' ? {} : parseInput(body, operation);
    const result = await ownershipTransfer(groupDid, auth.identity, operation, input);
    return NextResponse.json(result, { status: operation === 'propose' ? 201 : 200, headers });
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers });
    }
    log.error({ groupDid }, 'Ownership operation failed');
    return NextResponse.json({ error: 'Ownership operation failed' }, { status: 500, headers });
  }
}
