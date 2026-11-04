import { DomainError } from '@/src/lib/domains/normalize';
import { MailDomainError } from './postal-contract';

export function mailDomainErrorResponse(error: unknown): Response {
  if (error instanceof MailDomainError || error instanceof DomainError) {
    return Response.json({ error: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: 'mail_domain_unavailable' }, { status: 503 });
}
