import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const POST = cloudflareRoute('bulk');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
