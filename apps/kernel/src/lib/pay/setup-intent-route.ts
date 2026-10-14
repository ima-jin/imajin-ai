import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { createByoSetupIntent, verifyByoSetupIntent } from '@/src/lib/stripe/byo-setup-intent';
import { authenticatePayApp } from './app-service-auth';
import { PAY_SETUP_INTENT_SCOPE, SetupIntentError, setupIntentBody, verifySetupIntentBody } from './setup-intent';
import { SellerNoCardRailError } from './rails/stripe-keys';

/** Shared HTTP boundary: authenticate first; only then parse or spend the seller key. */
export async function handleSetupIntent(request: NextRequest, verify: boolean) {
  const headers = corsHeaders(request);
  try {
    const auth = await authenticatePayApp(request, PAY_SETUP_INTENT_SCOPE);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error, code: 'SETUP_APP_UNAUTHORIZED' }, { status: auth.status, headers });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SetupIntentError(400, 'setup_intent_invalid_request', 'Invalid JSON body');
    }
    const schema = verify ? verifySetupIntentBody : setupIntentBody;
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new SetupIntentError(400, 'setup_intent_invalid_request', 'Invalid payment setup fields');
    const result = verify
      ? await verifyByoSetupIntent(auth.appDid, verifySetupIntentBody.parse(parsed.data))
      : await createByoSetupIntent(auth.appDid, parsed.data);
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof SellerNoCardRailError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503, headers });
    }
    const failure = error instanceof SetupIntentError
      ? error
      : new SetupIntentError(503, 'SETUP_INTENT_UNAVAILABLE', 'Seller payment setup is unavailable');
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: failure.status, headers });
  }
}
