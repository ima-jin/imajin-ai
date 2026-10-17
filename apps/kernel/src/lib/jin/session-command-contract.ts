import { z } from 'zod';

const identifier = z.string().min(1).max(512).regex(/^\S+$/)
  .refine(value => Array.from(value).every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127));
const did = identifier.refine(value => value.startsWith('did:'));
const text = z.string().min(1).max(16_000);
const approval = { approvalId: identifier.optional() };
const payloads = {
  'session.send': z.object({ loopId: identifier, message: text, agentId: identifier.optional(), ...approval }).strict(),
  'session.abort': z.object({ loopId: identifier, runId: identifier.optional(), ...approval }).strict(),
  'session.spawn': z.object({
    task: text, parentLoopId: identifier.optional(), label: z.string().min(1).max(256).optional(),
    agentId: identifier.optional(), group: identifier.optional(), model: identifier.optional(), ...approval,
  }).strict(),
  'session.approve': z.object({ approvalId: identifier, loopId: identifier.optional(), kind: z.enum(['exec', 'plugin']).optional() }).strict(),
  'session.deny': z.object({ approvalId: identifier, loopId: identifier.optional(), kind: z.enum(['exec', 'plugin']).optional() }).strict(),
};

export type SessionCommandType = keyof typeof payloads;
export const sessionCommandTypeSchema = z.enum(['session.send', 'session.abort', 'session.spawn', 'session.approve', 'session.deny']);
export const sessionCommandSignatureSchema = z.object({
  keyId: z.string().regex(/^[a-f0-9]{64}$/i), alg: z.literal('ed25519'), sig: z.string().regex(/^[a-f0-9]{128}$/i),
}).strict();
export type SessionCommandSignature = z.infer<typeof sessionCommandSignatureSchema>;
export interface SessionCommandBody {
  type: SessionCommandType;
  commandId: string;
  to: string;
  principal: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  payload: Record<string, string>;
}
export interface SessionCommandFrame extends SessionCommandBody {
  signature: SessionCommandSignature;
  countersignature?: SessionCommandSignature;
}
export const sessionCommandFrameSchema = z.object({
  type: sessionCommandTypeSchema, commandId: identifier, to: did, principal: did, issuer: did,
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  payload: z.record(z.string()),
  signature: sessionCommandSignatureSchema, countersignature: sessionCommandSignatureSchema.optional(),
}).strict();
export const sessionBindingSchema = z.object({
  loopId: identifier, principalDid: did, agentDid: did, approvalId: identifier,
}).strict();
export type SessionBinding = z.infer<typeof sessionBindingSchema>;

/** Both grant and wish cover these exact fields, never either signature. */
export function sessionCommandBody(frame: SessionCommandBody): SessionCommandBody {
  const { type, commandId, to, principal, issuer, issuedAt, expiresAt, payload } = frame;
  return { type, commandId, to, principal, issuer, issuedAt, expiresAt, payload };
}

export function parseSessionCommandPayload(type: SessionCommandType, payload: unknown): Record<string, string> {
  return payloads[type].parse(payload) as Record<string, string>;
}

export const sessionAttestationSchema = z.object({
  from: did, type: z.literal('agent'), timestamp: z.number().int().nonnegative(),
  payload: z.record(z.unknown()), signature: z.string().regex(/^[a-f0-9]{128}$/i),
}).strict();
export type SessionAttestation = z.infer<typeof sessionAttestationSchema>;
export const sessionOutcomeSchema = z.object({
  eventType: z.string(), commandId: identifier, command: sessionCommandTypeSchema,
  outcome: z.enum(['completed', 'failed']), principal: did, issuer: did, agentDid: did,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime(),
  loopId: identifier.optional(), parentLoopId: identifier.nullable().optional(),
  childLoopId: identifier.optional(), reason: z.string().max(128).optional(),
  detail: z.string().max(512).optional(), approvalId: identifier.optional(),
  approvalKind: z.enum(['exec', 'plugin']).optional(), runId: identifier.optional(),
}).strict();
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;
