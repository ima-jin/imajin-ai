import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const GET = cloudflareRoute('classification');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
