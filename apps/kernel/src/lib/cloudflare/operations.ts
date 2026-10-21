import { z } from 'zod';
import { canonicalize } from '@imajin/auth';
import type { ZoneAuthority } from './authority';
import { mutation } from './audit';
import {
  CloudflareError, dnsCreateSchema, dnsPatchSchema, dnsRecordSchema, hostnameCreateSchema,
  hostnameSchema, hostnameIdSchema, idSchema, parse, cacheRuleOutputSchema, settingsSchema,
} from './schemas';

export function assertDnsName(name: string, domain: string): void {
  if (name !== domain && !name.endsWith(`.${domain}`)) throw new CloudflareError(403, 'record_outside_zone');
}

export async function dnsRecord(authority: ZoneAuthority, recordId: string) {
  parse(idSchema, recordId);
  const record = await authority.client.request(`/dns_records/${recordId}`, dnsRecordSchema);
  assertDnsName(record.name, authority.domain);
  return record;
}

export async function createDns(authority: ZoneAuthority, raw: unknown) {
  const input = parse(dnsCreateSchema, raw);
  assertDnsName(input.name, authority.domain);
  if (input.proxied) throw new CloudflareError(409, 'proxy_approval_required');
  // Explicitly DNS-only: do not depend on provider defaults when creating records.
  const after = { ...input, proxied: false };
  return mutation(authority, 'dns.create', null, after,
    () => authority.client.request('/dns_records', dnsRecordSchema, 'POST', after));
}

export async function patchDns(authority: ZoneAuthority, recordId: string, raw: unknown, approvalId?: string, expectedBefore?: unknown) {
  const input = parse(dnsPatchSchema, raw);
  if (input.proxied !== undefined && !approvalId) throw new CloudflareError(409, 'proxy_approval_required');
  if (input.name) assertDnsName(input.name, authority.domain);
  const before = await dnsRecord(authority, recordId);
  // A rename, type or target change must not move an already-proxied record to
  // an unclassified origin. Disable its proxy through approval before editing.
  if (before.proxied && ['name', 'type', 'content'].some(key => key in input)) {
    throw new CloudflareError(409, 'disable_proxy_before_edit');
  }
  if (expectedBefore !== undefined && canonicalize(before) !== canonicalize(expectedBefore)) {
    throw new CloudflareError(409, 'stale_plan');
  }
  return mutation(authority, 'dns.update', before, { ...before, ...input },
    () => authority.client.request(`/dns_records/${recordId}`, dnsRecordSchema, 'PATCH', input), approvalId);
}

export async function deleteDns(authority: ZoneAuthority, recordId: string) {
  const before = await dnsRecord(authority, recordId);
  return mutation(authority, 'dns.delete', before, null,
    () => authority.client.request(`/dns_records/${recordId}`, z.object({ id: idSchema }).strip(), 'DELETE'));
}

export async function listDns(authority: ZoneAuthority) {
  const records = await authority.client.list('/dns_records', dnsRecordSchema);
  records.forEach(record => assertDnsName(record.name, authority.domain));
  return records;
}

export async function createHostname(authority: ZoneAuthority, raw: unknown) {
  const input = parse(hostnameCreateSchema, raw);
  return mutation(authority, 'custom-hostnames.create', null, input,
    () => authority.client.request('/custom_hostnames', hostnameSchema, 'POST', input));
}

export async function hostname(authority: ZoneAuthority, hostnameId: string) {
  parse(hostnameIdSchema, hostnameId);
  return authority.client.request(`/custom_hostnames/${hostnameId}`, hostnameSchema);
}

export async function deleteHostname(authority: ZoneAuthority, hostnameId: string) {
  const before = await hostname(authority, hostnameId);
  return mutation(authority, 'custom-hostnames.delete', before, null,
    () => authority.client.request(`/custom_hostnames/${hostnameId}`, z.object({ id: hostnameIdSchema }).strip(), 'DELETE'));
}

export async function cacheRules(authority: ZoneAuthority) {
  const result = await authority.client.request('/rulesets/phases/http_request_cache_settings/entrypoint',
    z.object({ rules: z.array(cacheRuleOutputSchema).max(20).default([]) }).strip().nullable(), 'GET', undefined, true);
  return result?.rules ?? [];
}

export async function zoneSettings(authority: ZoneAuthority) {
  const settings = await authority.client.request('/settings', z.array(z.object({ id: z.string(), value: z.unknown(),
    editable: z.boolean().optional() }).strip()).max(200));
  return settings.flatMap(setting => {
    const parsed = settingsSchema.safeParse(setting);
    return parsed.success ? [parsed.data] : [];
  });
}
