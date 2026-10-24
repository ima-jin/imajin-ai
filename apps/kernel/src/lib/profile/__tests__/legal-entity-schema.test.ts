import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_MAX_BYTES, validateLegalEntityInput,
} from '../legal-entity-schema';
import { composeLegalEntity, composeLegalEntityRevocation, parseLegalEntity } from '../legal-entity-document';
import { legalEntityFixture, ownerDid } from './legal-entity-fixture';

describe('legal-entity:v1 validation', () => {
  it.each(['did:imajin:human', 'did:imajin:business'])('round trips a record attached to %s', did => {
    const input = legalEntityFixture();
    input.visibility.legalName = 'never';
    input.visibility['address.line1'] = 'public';
    const parsed = parseLegalEntity(composeLegalEntity(did, input), did);
    expect(parsed.input).toEqual(input);
    expect(parsed.releasePolicy.legalName.release).toBe('never');
    expect(parsed.releasePolicy['address.line1'].release).toBe('silent');
    expect(parsed.releasePolicy.operatingName.proof_grade).toBe('signed');
  });
  it('supports absent optional names/address line 2, and countries without regions or postcodes', () => {
    const input = legalEntityFixture();
    delete input.operatingName;
    delete input.address.line2;
    input.address.region = '';
    input.address.postalCode = '';
    input.address.country = 'HK';
    expect(validateLegalEntityInput(input)).toEqual(input);
  });
  it.each(['legalName', 'operatingName', 'address.line1', 'address.line2', 'address.city', 'address.region', 'address.postalCode'])(
    'rejects wrong types and overlong %s', field => {
      for (const value of [42, null, 'a'.repeat(201)]) {
        const input = legalEntityFixture();
        const [root, sub] = field.split('.');
        if (sub) Object.assign(input.address, { [sub]: value });
        else Object.assign(input, { [root]: value });
        expect(() => validateLegalEntityInput(input)).toThrow(field);
      }
    },
  );
  it.each(['legalName', 'address.line1', 'address.city'])('requires nonblank %s', field => {
    const input = legalEntityFixture();
    const [root, sub] = field.split('.');
    if (sub) Object.assign(input.address, { [sub]: '  ' });
    else Object.assign(input, { [root]: '  ' });
    expect(() => validateLegalEntityInput(input)).toThrow(field);
  });
  it.each(['legalName', 'address', 'schema', 'visibility'])('rejects missing %s', field => {
    const input: Record<string, unknown> = legalEntityFixture();
    delete input[field];
    expect(() => validateLegalEntityInput(input)).toThrow(field);
  });
  it.each(['line1', 'city', 'region', 'postalCode', 'country'])('rejects missing address.%s', field => {
    const input = legalEntityFixture();
    Reflect.deleteProperty(input.address, field);
    expect(() => validateLegalEntityInput(input)).toThrow(`address.${field}`);
  });
  it.each(['ZZ', 'CAN', 'ca', '', 12, null])('rejects invalid ISO country %s', country => {
    const input = legalEntityFixture();
    Object.assign(input.address, { country });
    expect(() => validateLegalEntityInput(input)).toThrow('address.country');
  });
  it.each(LEGAL_ENTITY_FIELDS)('requires an explicit valid visibility for %s', field => {
    for (const value of [undefined, 'private', 'silent', null]) {
      const input = legalEntityFixture();
      Object.assign(input.visibility, { [field]: value });
      expect(() => validateLegalEntityInput(input)).toThrow(`visibility.${field}`);
    }
  });
  it.each([null, [], 'text', 1])('rejects a non-record %s', input => {
    expect(() => validateLegalEntityInput(input)).toThrow();
  });
  it('rejects unknown fields including tax numbers, arbitrary release fields, and foreign DIDs', () => {
    for (const extra of [{ taxNumbers: [] }, { taxRegistrations: [] }, { did: 'foreign' }, { schema: 'legal-entity:v2' }]) {
      expect(() => validateLegalEntityInput({ ...legalEntityFixture(), ...extra })).toThrow(Object.keys(extra)[0]);
    }
    const input = legalEntityFixture();
    Object.assign(input.address, { taxNumber: 'not permitted' });
    expect(() => validateLegalEntityInput(input)).toThrow('address.taxNumber');
    const other = legalEntityFixture();
    Object.assign(other.visibility, { taxNumber: 'public' });
    expect(() => validateLegalEntityInput(other)).toThrow('visibility.taxNumber');
  });
});

function changeHeader(change: (data: Record<string, any>) => void) {
  const content = composeLegalEntity(ownerDid, legalEntityFixture());
  const data = parse(content.split('---')[1]);
  change(data);
  return `---\n${stringify(data)}---\n`;
}
describe('legal-entity frontmatter release header', () => {
  it('quotes values safely rather than permitting YAML injection', () => {
    const input = legalEntityFixture();
    input.legalName = 'Name:\nrelease:\n  legalName: public';
    expect(parseLegalEntity(composeLegalEntity(ownerDid, input), ownerDid).input?.legalName).toBe(input.legalName);
  });
  it('size caps the serialized signed source, including non-ASCII bytes', () => {
    const content = composeLegalEntity(ownerDid, legalEntityFixture());
    expect(() => parseLegalEntity(content + 'é'.repeat(LEGAL_ENTITY_MAX_BYTES / 2), ownerDid)).toThrow('legalEntity');
    expect(() => parseLegalEntity(content.padEnd(LEGAL_ENTITY_MAX_BYTES, ' '), ownerDid)).not.toThrow();
  });
  it.each([
    ['kind', (data: Record<string, any>) => { data.kind = 'other'; }],
    ['did', (data: Record<string, any>) => { data.did = 'did:imajin:foreign'; }],
    ['schema', (data: Record<string, any>) => { data.schema = 'legal-entity:v2'; }],
    ['release.legalName', (data: Record<string, any>) => { delete data.release.legalName; }],
    ['release.legalName', (data: Record<string, any>) => { data.release.legalName.release = 'owner-only'; }],
    ['release.taxNumber', (data: Record<string, any>) => { data.release.taxNumber = data.release.legalName; }],
    ['release', (data: Record<string, any>) => { data.release = []; }],
    ['release', (data: Record<string, any>) => { data.release.legalName.release = 'invalid'; }],
    ['release', (data: Record<string, any>) => { data.release.legalName.sensitive = true; data.release.legalName.release = 'silent'; }],
    ['revoked', (data: Record<string, any>) => { data.revoked = false; }],
    ['revoked', (data: Record<string, any>) => { data.revoked = true; }],
  ] as const)('rejects malformed %s rather than silently releasing', (field, change) => {
    expect(() => parseLegalEntity(changeHeader(change), ownerDid)).toThrow(field);
  });
  it('fails closed on invalid YAML or absent headers', () => {
    expect(() => parseLegalEntity('---\n: [bad\n---', ownerDid)).toThrow('kind');
    expect(() => parseLegalEntity('no header', ownerDid)).toThrow('kind');
  });
  it('revokes using a value-free, versioned, owner-bound tombstone', () => {
    const tombstone = composeLegalEntityRevocation(ownerDid);
    expect(parseLegalEntity(tombstone, ownerDid)).toEqual({ input: null, releasePolicy: {} });
    expect(tombstone).not.toContain('Example');
    expect(() => parseLegalEntity(tombstone.replace('legal-entity:v1', 'legal-entity:v2'), ownerDid)).toThrow('revoked');
  });
});
