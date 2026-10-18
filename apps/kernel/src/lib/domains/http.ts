import { createLogger } from '@imajin/logger';
import { DomainError } from '@/src/lib/domains/service';

const log = createLogger('domains');

export function domainErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  // Do not expose resolver/provider/database errors or configuration to clients.
  log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Domain operation failed');
  return Response.json({ error: 'Domain operation failed' }, { status: 500 });
}
