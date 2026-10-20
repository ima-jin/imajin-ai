import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const PATCH = cloudflareRoute('patchDns');
export const DELETE = cloudflareRoute('deleteDns');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
