import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { authenticateOnboardApp, onboardSendBody, sendOrderOnboard } from '@/src/lib/auth/app-onboard';

export const dynamic = 'force-dynamic';
export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
const log = createLogger('kernel');

/** The app requests delivery for its kernel-bound order; it never handles the login credential. */
export async function POST(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const app = await authenticateOnboardApp(request);
    if ('error' in app) return NextResponse.json({ error: app.error }, { status: app.status, headers });
    const body: unknown = await request.json().catch(() => null);
    const parsed = onboardSendBody.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Only transactionId is accepted' }, { status: 400, headers });
    const result = await sendOrderOnboard(app, parsed.data.transactionId);
    if ('error' in result) {
      if (result.retryAfter !== undefined) Object.assign(headers, { 'Retry-After': String(result.retryAfter) });
      return NextResponse.json({ error: result.error }, { status: result.status, headers });
    }
    return NextResponse.json(result, { headers });
  } catch {
    // Provider/DB errors may contain the bearer, email or verify URL. Never log their raw message.
    log.error({}, 'Order onboarding delivery unavailable');
    return NextResponse.json({ error: 'Onboarding delivery unavailable' }, { status: 503, headers });
  }
}
