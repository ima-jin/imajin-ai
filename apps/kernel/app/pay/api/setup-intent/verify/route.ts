import { NextRequest } from 'next/server';
import { handleSetupIntent } from '@/src/lib/pay/setup-intent-route';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

/** Read-only verification on the seller account, scoped to the creating app. */
export async function POST(request: NextRequest) {
  return handleSetupIntent(request, true);
}
