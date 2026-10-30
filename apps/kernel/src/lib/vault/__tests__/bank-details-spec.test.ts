import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { listApiSpecs } from '@/src/lib/kernel/api-specs';
import { GET } from '@/app/auth/api/spec/route';

const root = resolve('apps/kernel');
const spec = parse(readFileSync(resolve(root, 'api-spec/auth.yaml'), 'utf8'));
afterEach(() => vi.restoreAllMocks());

it('discovers and serves the bank-details contract on the normal auth spec', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  expect(listApiSpecs().find(item => item.service === 'auth')?.paths).toContain('/api/bank-details');
  const response = await GET();
  expect(parse(await response.text()).paths['/api/bank-details']).toEqual(spec.paths['/api/bank-details']);
  for (const method of ['get', 'put', 'delete']) {
    expect(spec.paths['/api/bank-details'][method].security).toEqual([{ cookieAuth: [] }]);
  }
});

it('registers a mechanical document revocation and pins reference-only responses', () => {
  expect(ATTESTATION_TYPES).toContain('document.revoked');
  expect(MECHANICAL_ATTESTATION_TYPES).toContain('document.revoked');
  const schemas = spec.components.schemas;
  expect(schemas.BankDetailsInput.additionalProperties).toBe(false);
  expect(schemas.BankDetailsInput.anyOf).toHaveLength(4);
  expect(schemas.BankDetailsInput.properties.eft.required).toEqual(['institutionNumber', 'transitNumber', 'accountNumber']);
  expect(schemas.BankDetailsUsAccount.required).toEqual(['routingNumber', 'accountNumber', 'accountType']);
  expect(schemas.BankDetailsInput.properties.swift.anyOf).toEqual([{ required: ['iban'] }, { required: ['accountNumber'] }]);
  expect(Object.keys(schemas.BankDetailsProjection.properties)).not.toContain('sealed');
  expect(Object.keys(schemas.BankDetailsProjection.properties)).not.toContain('accountNumber');
  expect(schemas.BankDetailsVisibility.enum).toEqual(['silent', 'on-consent', 'owner-only', 'never']);
});
