import {
  LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_SCHEMA,
  type LegalEntityInput, type LegalEntityVisibilityMap,
} from '../legal-entity-schema';

export const ownerDid = 'did:imajin:legal-owner';
export const viewerDid = 'did:imajin:legal-viewer';
export function legalEntityFixture(): LegalEntityInput {
  return {
    schema: LEGAL_ENTITY_SCHEMA,
    legalName: 'Example Legal Ltd',
    operatingName: 'Example',
    address: { line1: '123 Example Street', line2: 'Unit 4', city: 'Toronto', region: 'ON', postalCode: 'M5V 1A1', country: 'CA' },
    visibility: Object.fromEntries(LEGAL_ENTITY_FIELDS.map(field => [field, 'on-consent'])) as LegalEntityVisibilityMap,
  };
}
