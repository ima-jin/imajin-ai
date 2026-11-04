import { z } from 'zod';

const recordSchema = z.object({
  kind: z.enum(['ownership', 'spf', 'dkim', 'return_path', 'mx']),
  type: z.enum(['TXT', 'CNAME', 'MX']),
  name: z.string().min(1),
  value: z.string().min(1),
  required: z.boolean(),
  status: z.enum(['Unchecked', 'Pending', 'OK', 'Missing', 'Invalid']),
  error: z.string().nullable(),
  include: z.string().regex(/^include:[a-z0-9.-]+$/i).optional(),
  priority: z.number().int().nonnegative().optional(),
});

export type MailDnsRecord = {
  kind: 'ownership' | 'spf' | 'dkim' | 'return_path' | 'mx';
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  required: boolean;
  status: string;
  error: string | null;
  include?: string;
  priority?: number;
};
export type MailDomainStatus = {
  ownerDid: string;
  domain: string;
  state: 'pending' | 'verified' | 'disabled';
  ownershipVerified: boolean;
  dnsOk: boolean;
  records: MailDnsRecord[];
  checkedAt: string | null;
};

export const postalDomainSchema = z.object({
  organization: z.string().min(1),
  name: z.string().min(1),
  id: z.string().min(1),
  state: z.enum(['pending', 'verified']),
  ownership_verified: z.boolean(),
  dns_ok: z.boolean(),
  verified_at: z.iso.datetime().nullable(),
  dns_checked_at: z.iso.datetime().nullable(),
  records: z.array(recordSchema).min(3),
}).superRefine((value, ctx) => {
  const expected = value.ownership_verified && value.dns_ok ? 'verified' : 'pending';
  const required = ['ownership', 'spf', 'dkim'] as const;
  const invalid = value.state !== expected || required.some(kind =>
    value.records.filter(record => record.kind === kind && record.type === 'TXT' && record.required).length !== 1)
    || !value.records.some(record => record.kind === 'spf' && record.include);
  if (invalid) ctx.addIssue({ code: 'custom', message: 'Invalid Postal domain representation' });
});

export type PostalDomain = z.infer<typeof postalDomainSchema>;

export class MailDomainError extends Error {
  constructor(public readonly code: string, public readonly status = 503) {
    super(code);
    this.name = 'MailDomainError';
  }
}

/** This allowlist is the sole DNS-writer seam; optional inbound MX never escapes it. */
export function publishableMailRecords(status: MailDomainStatus): MailDnsRecord[] {
  return status.records.filter(record => ['ownership', 'spf', 'dkim', 'return_path'].includes(record.kind));
}

/** Merge into ONE policy, preserving the existing provider and its all qualifier. */
export function mergeSpfInclude(existing: string | null, include: string): string {
  if (!/^include:[a-z0-9.-]+$/i.test(include)) throw new MailDomainError('invalid_spf_include', 400);
  if (existing === null) return `v=spf1 ${include} ~all`;
  const terms = existing.trim().split(/\s+/);
  if (terms[0]?.toLowerCase() !== 'v=spf1') throw new MailDomainError('invalid_spf_record', 409);
  if (terms.some(term => (term.startsWith('+') ? term.slice(1) : term).toLowerCase() === include.toLowerCase())) return existing;
  const all = terms.findIndex(term => /^[+?~-]?all$/i.test(term));
  terms.splice(all < 0 ? terms.length : all, 0, include);
  return terms.join(' ');
}
