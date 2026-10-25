import { sshGrantRoute } from '@/src/lib/vault/ssh-cert-route';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => sshGrantRoute(request, true);
