import { cloudflareRoute } from '@/src/lib/cloudflare/routes';
export const dynamic = 'force-dynamic';
export const GET = cloudflareRoute('listHostnames');
export const POST = cloudflareRoute('createHostname');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
