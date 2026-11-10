import { z } from 'zod';

export const ALPHA_INTENTS = ['tester', 'integrator', 'partner', 'demo'] as const;
export type AlphaIntent = typeof ALPHA_INTENTS[number];

export const ALPHA_CHOICES: ReadonlyArray<{ value: AlphaIntent; label: string; description: string }> = [
  { value: 'tester', label: 'Tester', description: 'Try the alpha and tell us what works and what needs attention.' },
  { value: 'integrator', label: 'Integrator', description: 'Explore connecting your agent runtime to Imajin.' },
  { value: 'partner', label: 'Partner', description: 'Explore a pilot for your business, platform or agency.' },
  { value: 'demo', label: 'Book a demo', description: 'Talk with us and see Imajin in use.' },
];

export const ALPHA_LIMITS = { name: 120, email: 254, company: 200, purpose: 1000 } as const;
export const ALPHA_CONFIRMATION = 'Thank you — someone from Imajin will reach out to you.';
export const ALPHA_RATE_LIMIT = 5;
export const ALPHA_RATE_WINDOW_MS = 60 * 60 * 1000;
export const ALPHA_BODY_LIMIT = 16_384;

export function isAlphaIntent(value: unknown): value is AlphaIntent {
  return typeof value === 'string' && ALPHA_INTENTS.includes(value as AlphaIntent);
}

export function initialAlphaIntent(value: unknown): AlphaIntent {
  return isAlphaIntent(value) ? value : 'tester';
}

const boundedText = (max: number) => z.string().max(max).trim().min(1);
export const alphaSubmissionInput = z.object({
  name: boundedText(ALPHA_LIMITS.name),
  email: z.string().max(ALPHA_LIMITS.email).trim().pipe(z.email()).transform(value => value.toLowerCase()),
  company: boundedText(ALPHA_LIMITS.company),
  intent: z.enum(ALPHA_INTENTS),
  purpose: boundedText(ALPHA_LIMITS.purpose),
  website: z.literal('').optional(),
}).strict();

export type AlphaSubmissionInput = Omit<z.infer<typeof alphaSubmissionInput>, 'website'>;
export interface AlphaSubmissionRow extends AlphaSubmissionInput {
  id: string;
  createdAt: string;
}
export interface AlphaSubmissionsPage {
  submissions: AlphaSubmissionRow[];
  hasMore: boolean;
}
