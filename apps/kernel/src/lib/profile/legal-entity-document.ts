import { stringify } from 'yaml';
import { parseReleasePolicy, type ReleasePolicy } from '../media/release-policy';
import {
  LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_SCHEMA, LEGAL_ENTITY_MAX_BYTES,
  LegalEntityValidationError, validateLegalEntityInput,
  type LegalEntityInput, type LegalEntityVisibilityMap, type LegalEntityField,
} from './legal-entity-schema';

/** Public is the UI name for the existing header's silent release tier. */
export function composeLegalEntity(did: string, input: LegalEntityInput): string {
  const { visibility, ...values } = validateLegalEntityInput(input);
  const release = Object.fromEntries(LEGAL_ENTITY_FIELDS.map(field => [field, {
    discloses_others: false,
    sensitive: false,
    release: visibility[field] === 'public' ? 'silent' : visibility[field],
    proof_grade: 'signed',
  }]));
  return `---\n${stringify({ kind: 'legal-entity', did, ...values, release })}---\n`;
}

/** A signed, value-free tombstone follows the same document.changed revoke rail (#1208). */
export function composeLegalEntityRevocation(did: string): string {
  return `---\n${stringify({ kind: 'legal-entity', schema: LEGAL_ENTITY_SCHEMA, did, revoked: true })}---\n`;
}

export function parseLegalEntity(content: string, did: string): {
  input: LegalEntityInput | null;
  releasePolicy: ReleasePolicy;
} {
  if (Buffer.byteLength(content, 'utf8') > LEGAL_ENTITY_MAX_BYTES) {
    throw new LegalEntityValidationError('legalEntity', `exceeds ${LEGAL_ENTITY_MAX_BYTES} bytes`);
  }
  const parsed = parseReleasePolicy(content);
  if ('error' in parsed) throw new LegalEntityValidationError('release', parsed.error);
  const { kind, did: subject, release, revoked, ...values } = parsed.data;
  if (kind !== 'legal-entity') throw new LegalEntityValidationError('kind', 'must be legal-entity');
  if (subject !== did) throw new LegalEntityValidationError('did', 'must match the owner DID');
  if (revoked === true) {
    if (values.schema !== LEGAL_ENTITY_SCHEMA || Object.keys(values).length !== 1 || release !== undefined) {
      throw new LegalEntityValidationError('revoked', 'tombstone must contain no values or release rules');
    }
    return { input: null, releasePolicy: {} };
  }
  if (revoked !== undefined) throw new LegalEntityValidationError('revoked', 'must be absent or true');
  const visibility = {} as LegalEntityVisibilityMap;
  for (const field of LEGAL_ENTITY_FIELDS) {
    const rule = parsed.releasePolicy[field];
    if (!rule || rule.release === 'owner-only') {
      throw new LegalEntityValidationError(`release.${field}`, 'must declare public (silent), on-consent or never');
    }
    visibility[field] = rule.release === 'silent' ? 'public' : rule.release;
  }
  const unknownField = Object.keys(parsed.releasePolicy).find(field => !LEGAL_ENTITY_FIELDS.includes(field as LegalEntityField));
  if (unknownField) throw new LegalEntityValidationError(`release.${unknownField}`, 'unknown field');
  return { input: validateLegalEntityInput({ ...values, visibility }), releasePolicy: parsed.releasePolicy };
}
