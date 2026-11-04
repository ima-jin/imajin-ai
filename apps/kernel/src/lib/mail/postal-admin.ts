import { loadAndUnseal } from '@/src/lib/vault';
import { MailDomainError, postalDomainSchema, type PostalDomain } from './postal-contract';

/** Exact operator-supplied vault field, never an environment variable or generated secret. */
export const POSTAL_ADMIN_TOKEN_FIELD = 'POSTAL_ADMIN_TOKEN';

function adminConfig() {
  try {
    const url = new URL(process.env.POSTAL_ADMIN_URL ?? '');
    const organization = process.env.POSTAL_ORGANIZATION ?? '';
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(organization)
      || organization.length > 255) throw new Error('Invalid configuration');
    return { url, organization };
  } catch {
    throw new MailDomainError('postal_not_configured');
  }
}

/** Only create, read and check exist in Postal's narrow domain contract. */
export async function requestPostalDomain(domain: string, operation: 'create' | 'read' | 'check'): Promise<PostalDomain> {
  const { url, organization } = adminConfig();
  let token: string | undefined;
  try {
    token = await loadAndUnseal(POSTAL_ADMIN_TOKEN_FIELD);
  } catch {
    throw new MailDomainError('postal_credential_unavailable');
  }
  if (!token || /\s/.test(token)) throw new MailDomainError('postal_credential_unavailable');
  const create = operation === 'create';
  url.pathname = `/imajin/v1/domains${create ? '' : `/${encodeURIComponent(domain)}${operation === 'check' ? '/check' : ''}`}`;
  if (!create) url.searchParams.set('organization', organization);
  try {
    const response = await fetch(url, {
      method: operation === 'read' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(create ? { body: JSON.stringify({ organization, name: domain }) } : {}),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) {
      throw new MailDomainError(response.status === 401 ? 'postal_unauthorized' : 'postal_unavailable');
    }
    const parsed = postalDomainSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.name !== domain || parsed.data.organization !== organization) {
      throw new MailDomainError('postal_invalid_response');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof MailDomainError) throw error;
    // Never propagate fetch/parser errors: they can contain headers or response bodies.
    throw new MailDomainError('postal_unavailable');
  }
}
