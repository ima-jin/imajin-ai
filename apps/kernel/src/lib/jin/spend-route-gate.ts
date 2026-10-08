/**
 * Operator gate shared by the Spend lane routes (#2725) — identical to the
 * rule `GET /jin/api/grants` applies: the HUMAN node operator authenticated
 * directly (never delegated). Everyone else, `@jin` included, gets the
 * `{ isOperator: false }` envelope — indistinguishable from "nothing here".
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { getOperatorDid, isOperatorIdentity } from '@/src/lib/notify/operator-approvals';

export type OperatorGate = { operatorDid: string } | { response: NextResponse };

export async function gateOperator(request: NextRequest, cors: HeadersInit, emptyBody: object): Promise<OperatorGate> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { response: NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors }) };
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(authResult.identity, operatorDid)) {
    return { response: NextResponse.json({ isOperator: false, ...emptyBody }, { headers: cors }) };
  }
  return { operatorDid };
}
