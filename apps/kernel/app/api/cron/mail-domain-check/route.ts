import { requireCronAuth } from '@/src/cron/auth';
import { pollMailDomains } from '@/src/lib/mail/postal-domains';
import { mailDomainErrorResponse } from '@/src/lib/mail/domain-http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;
  try {
    return Response.json({ ok: true, ...await pollMailDomains() });
  } catch (error) {
    return mailDomainErrorResponse(error);
  }
}
