import type { NextRequest } from 'next/server';
import { orgConnectionMemberGrantRoute } from '@/src/lib/kernel/org-connection-member-grant-route';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ provider: string }> };
async function handle(request: NextRequest, context: Context) {
  const { provider } = await context.params;
  return orgConnectionMemberGrantRoute(request, provider);
}
export { handle as GET, handle as POST, handle as DELETE };
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
