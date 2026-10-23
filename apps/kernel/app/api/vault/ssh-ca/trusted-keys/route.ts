import { trustedSshCaKeys } from '@/src/lib/vault/ssh-ca';
import { isSshCaPurpose } from '@/src/lib/vault/ssh-ca-policy';
import { sshCaFailure, sshCaJson } from '@/src/lib/vault/ssh-ca-route';

export const dynamic = 'force-dynamic';

/** Anonymous, public-only TrustedUserCAKeys contents for one purpose. */
export async function GET(request: Request) {
  const purpose = new URL(request.url).searchParams.get('purpose');
  if (!isSshCaPurpose(purpose)) return sshCaJson({ error: 'Invalid SSH CA purpose' }, 400);
  try {
    return new Response(await trustedSshCaKeys(purpose), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return sshCaFailure(error);
  }
}
