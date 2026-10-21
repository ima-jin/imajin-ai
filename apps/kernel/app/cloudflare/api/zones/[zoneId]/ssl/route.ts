import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const GET = cloudflareRoute('ssl');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
