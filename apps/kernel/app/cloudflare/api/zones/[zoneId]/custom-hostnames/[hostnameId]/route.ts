import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const GET = cloudflareRoute('hostname');
export const DELETE = cloudflareRoute('deleteHostname');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
