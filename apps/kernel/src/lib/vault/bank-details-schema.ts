import { z } from 'zod';
import type { ReleaseTier } from '@/src/lib/media/release-policy';

export const BANK_DETAILS_KIND = 'bank-details:v1';
export const BANK_RAILS = ['eft', 'ach', 'wire', 'swift'] as const;
export type BankRail = typeof BANK_RAILS[number];
export const BANK_PUBLIC_FIELDS = ['accountHolderName', 'bankName', 'country', 'currency', 'rails', 'accountTypes', 'bic'] as const;
export type BankPublicField = typeof BANK_PUBLIC_FIELDS[number];

/** ABA weighted checksum; reject the all-zero sentinel even though its sum is zero. */
export function validAba(value: string): boolean {
  if (!/^\d{9}$/.test(value) || /^0+$/.test(value)) return false;
  const weights = [3, 7, 1];
  return Array.from(value).reduce((sum, digit, index) => sum + Number(digit) * weights[index % 3], 0) % 10 === 0;
}

/** Streaming mod-97 avoids precision loss and never builds a giant JS number. */
export function validIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  let remainder = 0;
  for (const character of value.slice(4) + value.slice(0, 4)) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const accountNumber = z.string().regex(/^\d{1,34}$/);
const usAccount = z.object({
  routingNumber: z.string().refine(validAba),
  accountNumber: z.string().regex(/^\d{1,17}$/),
  accountType: z.enum(['checking', 'savings']),
}).strict();
const swiftAccount = z.object({
  bic: z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/),
  iban: z.string().refine(validIban).optional(),
  accountNumber: accountNumber.optional(),
}).strict().refine(value => Boolean(value.iban || value.accountNumber), { path: ['iban'] });
const visibility = z.object({
  accountHolderName: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  bankName: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  country: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  currency: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  rails: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  accountTypes: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
  bic: z.enum(['silent', 'on-consent', 'owner-only', 'never']).optional(),
}).strict();

export const bankDetailsInputSchema = z.object({
  accountHolderName: z.string().trim().min(1).max(200),
  bankName: z.string().trim().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  eft: z.object({
    institutionNumber: z.string().regex(/^\d{3}$/),
    transitNumber: z.string().regex(/^\d{5}$/),
    accountNumber,
  }).strict().optional(),
  ach: usAccount.optional(),
  wire: usAccount.optional(),
  swift: swiftAccount.optional(),
  visibility: visibility.optional(),
}).strict().refine(value => BANK_RAILS.some(rail => value[rail]), { path: ['rails'] });
export type BankDetailsInput = z.infer<typeof bankDetailsInputSchema>;

export class BankDetailsValidationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid field: ${field}`);
  }
}

/** Never return Zod errors: they may carry caller-submitted financial values. */
export function parseBankDetailsInput(raw: unknown): BankDetailsInput {
  const parsed = bankDetailsInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join('.');
    throw new BankDetailsValidationError(path || 'body');
  }
  return parsed.data;
}

export interface BankDetailsPublic {
  accountHolderName: string;
  bankName: string;
  country: string;
  currency: string;
  rails: BankRail[];
  accountTypes: Partial<Record<'ach' | 'wire', 'checking' | 'savings'>>;
  bic?: string;
}
export interface BankSecretReference {
  field: string;
  keyId: string;
  cid: string;
}
export interface BankDetailsRecord {
  kind: typeof BANK_DETAILS_KIND;
  recordId: string;
  ownerDid: string;
  public: BankDetailsPublic;
  sealed: Record<string, BankSecretReference>;
  visibility: Record<BankPublicField, ReleaseTier>;
}

/** Explicit allowlist: the input itself is never spread into a persistent object. */
export function bankDetailsPublic(input: BankDetailsInput): BankDetailsPublic {
  return {
    accountHolderName: input.accountHolderName, bankName: input.bankName,
    country: input.country, currency: input.currency,
    rails: BANK_RAILS.filter(rail => Boolean(input[rail])),
    accountTypes: {
      ...(input.ach ? { ach: input.ach.accountType } : {}),
      ...(input.wire ? { wire: input.wire.accountType } : {}),
    },
    ...(input.swift ? { bic: input.swift.bic } : {}),
  };
}

export function bankDetailsVisibility(input: BankDetailsInput): BankDetailsRecord['visibility'] {
  return Object.fromEntries(BANK_PUBLIC_FIELDS.map(field => [field, input.visibility?.[field] ?? 'owner-only'])) as BankDetailsRecord['visibility'];
}

/** Transient in-memory values, passed directly to the existing kernel seal primitive. */
export function bankDetailsSecrets(input: BankDetailsInput): [string, string][] {
  const result: [string, string][] = [];
  for (const rail of BANK_RAILS) {
    const account = input[rail];
    if (!account) continue;
    for (const [field, value] of Object.entries(account)) {
      if (field !== 'accountType' && field !== 'bic') result.push([`${rail}.${field}`, value]);
    }
  }
  return result;
}

/** JSON is a YAML subset: quote every scalar/key to prevent frontmatter injection. */
export function bankDetailsDocument(record: BankDetailsRecord): string {
  const release: Record<string, unknown> = {};
  for (const field of BANK_PUBLIC_FIELDS) {
    release[field] = { discloses_others: false, sensitive: false, release: record.visibility[field], proof_grade: 'asserted' };
  }
  for (const field of Object.keys(record.sealed)) {
    release[field] = { discloses_others: true, sensitive: true, release: 'never', proof_grade: 'asserted' };
  }
  const header = {
    kind: record.kind, recordId: record.recordId, ownerDid: record.ownerDid,
    ...record.public, ...record.sealed, release,
  };
  return `---\n${JSON.stringify(header, null, 2)}\n---\n# Bank details\n`;
}
