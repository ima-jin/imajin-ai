import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { connectionSlot } from '@/src/lib/kernel/connection-slots';
import { updateGoogleSetup } from '@/src/lib/google/setup';
import { checkSearchConsoleSetup, readGoogleSetupView } from '@/src/lib/google/setup-checks';
import { GOOGLE_SETUP_STEPS, GOOGLE_SETUP_STATUSES, type GoogleSetupStepId, type GoogleSetupStatus } from '@/src/lib/google/setup-content';

const updateSchema = z.object({
  step: z.custom<GoogleSetupStepId>((value) => GOOGLE_SETUP_STEPS.some(({ id }) => id === value)),
  status: z.custom<GoogleSetupStatus>((value) => typeof value === 'string' && Object.hasOwn(GOOGLE_SETUP_STATUSES, value)),
  caseUrl: z.string().max(2048).url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'support.google.com' && !url.username && !url.password;
  }, 'Use an HTTPS Google support case URL').optional(),
}).strict().refine((value) => value.caseUrl === undefined || value.step === 'business-access', 'Case links belong to the Business Profile access request');

type SetupHandler = (request: NextRequest, ownerDid: string, slot: string) => Promise<NextResponse>;

function scoped(handler: SetupHandler) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
    const auth = await requireAuth(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
    let slot: string;
    try {
      slot = connectionSlot(new URL(request.url).searchParams.get('slot'));
    } catch {
      return NextResponse.json({ error: 'Invalid connection slot' }, { status: 400, headers });
    }
    try {
      const response = await handler(request, resolveActingDid(auth.identity), slot);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    } catch {
      return NextResponse.json({ error: 'Google setup is unavailable. Retry without submitting credentials.' }, { status: 500, headers });
    }
  };
}

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/** GET /google/api/setup?slot=primary — per-authenticated-identity checklist and vault/gate facts. */
export const GET = scoped(async (_request, ownerDid, slot) =>
  NextResponse.json(await readGoogleSetupView(ownerDid, slot)));

/** PATCH accepts only {step,status,caseUrl?}; deliberately no arbitrary notes or credential fields. */
export const PATCH = scoped(async (request, ownerDid, slot) => {
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid setup update. Supply a known step, status, and optional Google support case URL only.' }, { status: 400 });
  await updateGoogleSetup(ownerDid, slot, parsed.data.step, parsed.data.status, parsed.data.caseUrl);
  return NextResponse.json(await readGoogleSetupView(ownerDid, slot));
});

/** POST performs a live Search Console sites test; never marks Google approval. */
export const POST = scoped(async (_request, ownerDid, slot) => {
  const [view, searchConsole] = await Promise.all([
    readGoogleSetupView(ownerDid, slot),
    checkSearchConsoleSetup(ownerDid, slot),
  ]);
  return NextResponse.json({ ...view, checks: { searchConsole } });
});
