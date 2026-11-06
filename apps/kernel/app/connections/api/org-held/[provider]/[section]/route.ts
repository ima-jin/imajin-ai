import type { NextRequest } from 'next/server';
import { orgProviderManagement } from '@/src/lib/kernel/org-provider-management';
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

type Context = { params: Promise<{ provider: string; section: string }> };
async function handle(request: NextRequest, context: Context) {
  const { provider, section } = await context.params;
  return orgProviderManagement(request, provider, section);
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
