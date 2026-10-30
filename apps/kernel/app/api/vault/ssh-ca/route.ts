import { mutateSshCa } from '@/src/lib/vault/ssh-ca-route';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => mutateSshCa(request, 'mint');
