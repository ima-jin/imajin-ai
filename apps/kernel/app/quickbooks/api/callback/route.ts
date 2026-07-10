import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { exchangeCodeAndStore } from '@/src/lib/quickbooks/connector';
import { verifyState } from '@/src/lib/quickbooks/oauth-state';

const log = createLogger('kernel');

/**
 * GET /quickbooks/api/callback — Intuit redirects here with code, state, realmId.
 * There is no imajin session on this external redirect: the signed `state`
 * carries (and authenticates) the owner DID.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const realmId = searchParams.get('realmId');

  if (!code || !state || !realmId) {
    return NextResponse.json({ error: 'Missing code, state, or realmId' }, { status: 400 });
  }

  let ownerDid: string;
  try {
    ownerDid = verifyState(state);
  } catch (err) {
    log.warn({ err: String(err) }, 'QuickBooks callback: invalid state');
    return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
  }

  try {
    await exchangeCodeAndStore(ownerDid, code, realmId);
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'QuickBooks callback: token exchange failed');
    return NextResponse.json({ error: 'QuickBooks connection failed' }, { status: 502 });
  }

  return NextResponse.json({ connected: true });
}
