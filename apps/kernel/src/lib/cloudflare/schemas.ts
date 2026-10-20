import { z } from 'zod';
import { normalizeDomain } from '@/src/lib/domains/normalize';

export const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const domainSchema = z.string().max(253).refine(value => {
  try { return normalizeDomain(value) === value; } catch { return false; }
});
const dnsName = z.string().min(1).max(253).regex(/^(?:\*\.)?[a-z0-9_.-]+$/);
const dnsFields = {
  type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA']),
  name: dnsName,
  content: z.string().min(1).max(4096),
  ttl: z.number().int().refine(value => value === 1 || (value >= 60 && value <= 86400)),
  proxied: z.boolean().optional(),
  priority: z.number().int().min(0).max(65535).optional(),
};
export const dnsCreateSchema = z.object(dnsFields).strict();
export const dnsPatchSchema = dnsCreateSchema.partial().refine(value => Object.keys(value).length > 0);
export const dnsRecordSchema = z.object({
  ...dnsFields, id: idSchema, proxied: z.boolean(), proxiable: z.boolean().optional(),
}).strip();
const sslInput = z.object({
  method: z.enum(['http', 'txt']),
  type: z.literal('dv'),
  settings: z.object({
    min_tls_version: z.enum(['1.2', '1.3']).optional(),
    http2: z.enum(['on', 'off']).optional(),
  }).strict().optional(),
}).strict();
export const hostnameCreateSchema = z.object({ hostname: domainSchema, ssl: sslInput }).strict();
const verificationRecordSchema = z.object({
  txt_name: z.string().max(253).optional(), txt_value: z.string().max(4096).optional(),
  cname: z.string().max(253).optional(), cname_name: z.string().max(253).optional(), cname_target: z.string().max(253).optional(),
  http_url: z.string().max(2048).optional(), http_body: z.string().max(4096).optional(),
}).strip();
export const hostnameSchema = z.object({
  id: idSchema, hostname: domainSchema, status: z.string().max(100).optional(),
  ownership_verification: z.object({
    type: z.enum(['txt', 'TXT']), name: z.string().max(253), value: z.string().max(4096),
  }).strip().optional(),
  ownership_verification_http: z.object({ http_url: z.string().max(2048), http_body: z.string().max(4096) }).strip().optional(),
  ssl: z.object({ status: z.string().max(100).optional(), method: z.string().max(30).optional(),
    type: z.string().max(30).optional(),
    validation_records: z.array(verificationRecordSchema).max(20).optional(),
  }).strip().optional(),
}).strip();
export const cacheRuleSchema = z.object({
  ref: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  description: z.string().max(200).optional(),
  expression: z.string().min(1).max(2048),
  action: z.literal('set_cache_settings'),
  enabled: z.boolean(),
  action_parameters: z.object({
    cache: z.boolean().optional(),
    edge_ttl: z.object({
      mode: z.enum(['respect_origin', 'bypass_by_default', 'override_origin']),
      default: z.number().int().min(0).max(31536000).optional(),
    }).strict().optional(),
    browser_ttl: z.object({
      mode: z.enum(['respect_origin', 'bypass_by_default', 'override_origin']),
      default: z.number().int().min(0).max(31536000).optional(),
    }).strict().optional(),
  }).strict(),
}).strict();
// Output is separately allowlisted: provider metadata never becomes a write payload.
export const cacheRuleOutputSchema = cacheRuleSchema.extend({ id: idSchema.optional() }).strip();
export const cacheSetSchema = z.object({
  domain: domainSchema, rules: z.array(cacheRuleSchema).max(20), dryRun: z.boolean(),
}).strict();
export const bulkSchema = z.object({
  domain: domainSchema,
  changes: z.array(z.object({ recordId: idSchema, proxied: z.boolean() }).strict()).min(1).max(20),
  dryRun: z.boolean(),
}).strict().refine(body => new Set(body.changes.map(change => change.recordId)).size === body.changes.length);
export const settingsSchema = z.object({
  id: z.enum(['ssl', 'always_use_https', 'min_tls_version', 'tls_1_3', 'security_level', 'browser_cache_ttl', 'cache_level']),
  value: z.union([z.string().max(100), z.number(), z.boolean()]),
  editable: z.boolean().optional(),
}).strip();

export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new CloudflareError(400, 'invalid_request');
  return result.data;
}

export class CloudflareError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}
