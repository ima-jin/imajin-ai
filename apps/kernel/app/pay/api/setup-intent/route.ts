import { NextRequest } from 'next/server';
import { handleSetupIntent } from '@/src/lib/pay/setup-intent-route';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

/** Registered-app BYO-only creation; user sessions and platform intents are retired. */
export async function POST(request: NextRequest) {
  return handleSetupIntent(request, false);
}
