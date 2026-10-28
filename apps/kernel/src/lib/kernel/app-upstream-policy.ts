import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExternalMcpError, memberDidSchema } from './external-mcp-policy';

export const UPSTREAM_READ_SCOPE = 'connectors:upstream:read';
export const UPSTREAM_WRITE_SCOPE = 'connectors:upstream:write';
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
// Exact, canonical paths only. No URL, query, fragment, escaped separators or traversal.
const path = z.string().min(1).max(1024).regex(/^\/[a-zA-Z0-9/_-]*$/)
  .refine(value => !value.includes('//'));
const method = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const origin = z.string().max(512).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
});
const declaration = z.object({
  id: identifier, origin,
  // Deliberately not arbitrary headers: never overwrite Host, Cookie or routing metadata.
  credentialHeader: z.enum(['Authorization', 'X-API-Key']).default('Authorization'),
  credentialPrefix: z.enum(['Bearer ', '']).default('Bearer '),
  paths: z.array(z.object({ path, methods: z.array(method).min(1).max(7) }).strict()).min(1).max(64),
}).strict();
export const upstreamDeclarations = z.object({
  upstreams: z.array(declaration).max(16).refine(values => new Set(values.map(item => item.id)).size === values.length),
}).strict();
export type AppUpstream = z.infer<typeof declaration>;
export const upstreamSelector = z.object({ appDid: memberDidSchema, upstreamId: identifier }).strict();
export const upstreamConnectionInput = upstreamSelector.extend({
  // Member explicitly approves the destination rather than trusting an app's selector.
  origin,
  secret: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
  orgContextDid: memberDidSchema.optional(),
}).strict();
export const upstreamCallInput = z.object({
  memberDid: memberDidSchema, upstreamId: identifier, path, method,
  body: z.string().max(12_000).optional(),
  // Bounded reason codes cannot carry provider output, arguments or a credential.
  reason: z.enum(['member-request', 'app-workflow', 'scheduled-task']).optional(),
}).strict().refine(call => !['GET', 'HEAD'].includes(call.method) || call.body === undefined);
export type AppUpstreamCall = z.infer<typeof upstreamCallInput>;
export function parseUpstream<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ExternalMcpError(400, 'Invalid upstream input');
  return result.data;
}
export function upstreamProvider(appDid: string, upstreamId: string) {
  return `app-upstream:${appDid}:${upstreamId}`;
}
/** Canonical set of exact permissions, also the member-facing plain-text list. */
export function upstreamPermissions(target: Pick<AppUpstream, 'paths'>): string[] {
  const pairs = target.paths.flatMap(entry => entry.methods.map(verb => `${verb} ${entry.path}`));
  return [...new Set(pairs)].sort((left, right) => left < right ? -1 : Number(left > right));
}
export function upstreamBinding(appDid: string, target: AppUpstream) {
  return createHash('sha256').update(JSON.stringify([
    appDid, target.id, target.origin, target.credentialHeader, target.credentialPrefix,
    upstreamPermissions(target),
  ])).digest('hex');
}
export function assertDeclaredCall(target: AppUpstream, call: AppUpstreamCall) {
  if (!target.paths.some(entry => entry.path === call.path && entry.methods.includes(call.method))) {
    throw new ExternalMcpError(403, 'Undeclared upstream path or method');
  }
  if (!['GET', 'HEAD'].includes(call.method) && !call.reason) {
    throw new ExternalMcpError(400, 'Mutating upstream calls require a reason');
  }
}
