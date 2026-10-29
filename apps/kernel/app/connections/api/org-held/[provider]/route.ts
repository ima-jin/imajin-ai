import type { NextRequest } from 'next/server';
import { orgHeldConnectionRoute } from '@/src/lib/kernel/org-held-connection-route';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ provider: string }> };
async function handle(request: NextRequest, context: Context) {
  const { provider } = await context.params;
  return orgHeldConnectionRoute(request, provider);
}
export { handle as GET, handle as POST, handle as DELETE };
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
