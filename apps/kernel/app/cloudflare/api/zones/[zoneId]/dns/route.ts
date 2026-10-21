import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const GET = cloudflareRoute('listDns');
export const POST = cloudflareRoute('createDns');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
