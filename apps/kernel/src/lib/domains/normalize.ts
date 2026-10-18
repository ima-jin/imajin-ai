import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Accept DNS hostnames, never URLs, ports, wildcards, paths or IP literals. */
export function normalizeDomain(input: string): string {
  if (typeof input !== 'string' || input.length > 1024 || /[\s/:@?#\\%*]/u.test(input)) {
    throw new DomainError('invalid_domain', 'Enter a DNS hostname, not a URL');
  }
  const domain = domainToASCII(input.replace(/\.$/u, '')).toLowerCase();
  const labels = domain.split('.');
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (!domain || domain.length > 253 || labels.length < 2 || isIP(domain)
    || !labels.every((label) => validLabel.test(label)) || /^\d+$/u.test(labels.at(-1)!)) {
    throw new DomainError('invalid_domain', 'Enter a valid public DNS hostname');
  }
  return domain;
}

export function isImajinDomain(domain: string): boolean {
  return domain === 'imajin.ai' || domain.endsWith('.imajin.ai');
}
