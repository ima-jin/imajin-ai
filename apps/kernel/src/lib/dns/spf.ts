import { DnsError } from './types';
import { normalizeDomain } from '@/src/lib/domains/normalize';

export function isSpf(content: string): boolean {
  return /^v=spf1(?:\s|$)/iu.test(content.trim());
}

function terms(content: string): string[] {
  const tokens = content.trim().split(/\s+/u);
  if (!isSpf(content) || tokens.slice(1).some((term) => /^v=/iu.test(term))) {
    throw new DnsError('invalid_spf');
  }
  return tokens.slice(1);
}

function key(term: string): string {
  const positive = term.replace(/^\+/u, '');
  // Uppercase SPF macro letters apply URL escaping; they are not equivalent.
  return positive.includes('%') ? positive : positive.toLowerCase();
}

/**
 * Add only positive include mechanisms from the mail provider. Preserve the
 * owner's existing all qualifier, redirect and every other mechanism/modifier.
 * Ambiguous/broken policies need owner review, never a replacement policy.
 */
export function mergeSpf(existing: string | undefined, required: string): string {
  const additions = terms(required);
  if (additions.some((term) => !/^(?:\+?include:[a-z0-9.-]+|[~?-]all)$/iu.test(term))) {
    throw new DnsError('unsupported_spf_addition');
  }
  const policies = additions.filter((term) => /^[~?-]all$/iu.test(term));
  if (policies.length > 1 || (policies.length === 1 && additions.at(-1) !== policies[0])) {
    throw new DnsError('invalid_spf_order');
  }
  for (const term of additions.filter((entry) => /^\+?include:/iu.test(entry))) {
    normalizeDomain(term.slice(term.indexOf(':') + 1));
  }
  if (!existing) return ['v=spf1', ...new Map(additions.map((term) => [key(term), term])).values()].join(' ');
  const current = terms(existing);
  const all = current.filter((term) => /^[~?+-]?all$/iu.test(term));
  if (all.length > 1 || current.filter((term) => /^redirect=/iu.test(term)).length > 1) {
    throw new DnsError('ambiguous_spf');
  }
  const unique = [...new Map(current.map((term) => [key(term), term])).values()];
  const includes = additions.filter((term) => /^\+?include:/iu.test(term));
  const missing = includes.filter((term) => !unique.some((entry) => key(entry) === key(term)));
  if (missing.some((term) => unique.some((entry) => key(entry).replace(/^[~?-]/u, '') === key(term)))) {
    throw new DnsError('conflicting_spf_mechanism');
  }
  const end = unique.findIndex((term) => /^[~?+-]?all$/iu.test(term));
  if (end >= 0 && unique.slice(end + 1).some((term) => !term.includes('='))) {
    throw new DnsError('invalid_spf_order');
  }
  unique.splice(end < 0 ? unique.length : end, 0, ...missing);
  return ['v=spf1', ...unique].join(' ');
}
