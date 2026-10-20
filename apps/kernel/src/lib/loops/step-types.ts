import { z } from 'zod';

export const STEP_EVENT_TYPES = [
  'step.queued', 'step.updated', 'step.claimed', 'step.started', 'step.progress',
  'step.blocked', 'step.finished', 'step.observed', 'step.attested',
] as const;
export type StepEventType = (typeof STEP_EVENT_TYPES)[number];

export function isStepEventType(value: unknown): value is StepEventType {
  return typeof value === 'string' && (STEP_EVENT_TYPES as readonly string[]).includes(value);
}

const text = z.string().trim().min(1).max(2000);
const did = z.string().regex(/^did:[^\s:]+:\S+$/).max(512);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(256);
const condition = z.discriminatedUnion('kind', [
  z.object({ id: text, kind: z.literal('issue_closed') }).strict(),
  z.object({ id: text, kind: z.literal('release_contains') }).strict(),
  z.object({ id: text, kind: z.literal('deployed') }).strict(),
  z.object({ id: text, kind: z.literal('attestation'), attestorDid: did }).strict(),
]);
export type StepExitCondition = z.infer<typeof condition>;

const declaration = z.object({
  stepKind: z.enum(['code', 'human', 'ops']),
  intention: text,
  rank: z.number().finite(),
  repository: repository.optional(),
  exitConditions: z.array(condition).min(1).max(16),
}).strict().superRefine((step, ctx) => {
  const kinds = step.exitConditions.map(item => item.kind);
  const ids = step.exitConditions.map(item => item.id);
  const expected = step.stepKind === 'code' ? ['issue_closed', 'release_contains', 'deployed'] : ['attestation'];
  if (new Set(ids).size !== ids.length || kinds.length !== expected.length || !expected.every(kind => kinds.includes(kind as StepExitCondition['kind']))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Declare each required exit condition exactly once with distinct ids' });
  }
  if (step.stepKind === 'code' && !step.repository) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Code steps require a repository' });
  }
});
export type StepDeclaration = z.infer<typeof declaration>;

const update = z.object({
  rank: z.number().finite().optional(),
  intention: text.optional(),
  issue: z.object({ ref: text, outcome: z.string().max(2000).regex(/^OUTCOME\b/u).optional() }).strict().optional(),
  briefRef: text.optional(),
  provisionRef: text.optional(),
  designRef: text.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'An update must contain a fact');
export type StepUpdate = z.infer<typeof update>;

const claim = z.object({
  leaseId: text,
  holderDid: did,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type StepClaim = z.infer<typeof claim>;

const evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue_closed'), issue: text }).strict(),
  z.object({
    kind: z.literal('release_contains'), repository, issue: text,
    mergeCommit: z.string().regex(/^[0-9a-f]{40}$/i), tag: text,
  }).strict(),
  z.object({ kind: z.literal('deployed'), repository, tag: text, environment: z.literal('prod') }).strict(),
]);
export type StepEvidence = z.infer<typeof evidence>;
const observation = z.object({ conditionId: text, evidence }).strict();
const attestation = z.object({ conditionId: text, did, statement: text }).strict();
export type StepAttestation = z.infer<typeof attestation>;

const eventData = {
  'step.queued': z.object({ step: declaration }).strict(),
  'step.updated': z.object({ update }).strict(),
  'step.claimed': z.object({ claim }).strict(),
  'step.started': z.object({}).strict(),
  'step.progress': z.object({}).strict(),
  'step.blocked': z.object({}).strict(),
  'step.finished': z.object({}).strict(),
  'step.observed': z.object({ observation }).strict(),
  'step.attested': z.object({ attestation }).strict(),
};

/** Validate without reconstructing or inserting defaults into signed payloads. */
export function validateStepPayload(type: StepEventType, payload: Record<string, unknown>, publisherDid: string): boolean {
  if (!text.safeParse(payload.stepId).success || ['zone', 'depth', 'output'].some(key => key in payload) || payload.state === 'exited') return false;
  const fields = ['step', 'update', 'claim', 'observation', 'attestation'];
  const data = Object.fromEntries(fields.filter(key => key in payload).map(key => [key, payload[key]]));
  if (!eventData[type].safeParse(data).success) return false;
  if (type === 'step.queued' && payload.state !== 'queued') return false;
  if (type === 'step.claimed' && (payload.claim as StepClaim).holderDid !== publisherDid) return false;
  return type !== 'step.attested' || (payload.attestation as StepAttestation).did === publisherDid;
}
