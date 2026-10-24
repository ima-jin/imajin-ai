import { z } from 'zod';
import { PROFILE_JSONB_LIMITS } from './jsonb-limits';

export const LEGAL_ENTITY_SCHEMA = 'legal-entity:v1' as const;
export const LEGAL_ENTITY_MAX_BYTES = PROFILE_JSONB_LIMITS.taxRegistrations.maxBytes;
export const LEGAL_ENTITY_FIELDS = [
  'legalName', 'operatingName', 'address.line1', 'address.line2',
  'address.city', 'address.region', 'address.postalCode', 'address.country',
] as const;
export type LegalEntityField = typeof LEGAL_ENTITY_FIELDS[number];
export const LEGAL_ENTITY_VISIBILITIES = ['public', 'on-consent', 'never'] as const;
export type LegalEntityVisibility = typeof LEGAL_ENTITY_VISIBILITIES[number];
export type LegalEntityVisibilityMap = Record<LegalEntityField, LegalEntityVisibility>;

// ISO 3166-1 alpha-2, including territories. Shape alone would accept ZZ.
const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const text = z.string().trim().max(200);
const valuesSchema = z.object({
  legalName: text.min(1),
  operatingName: text.optional(),
  address: z.object({
    line1: text.min(1),
    line2: text.optional(),
    city: text.min(1),
    // Many countries have neither a region nor postal codes.
    region: text,
    postalCode: text,
    country: z.string().refine(value => COUNTRIES.has(value), 'must be an ISO 3166-1 alpha-2 country code'),
  }).strict(),
}).strict();
const visibility = z.enum(LEGAL_ENTITY_VISIBILITIES);
const visibilitySchema = z.object(Object.fromEntries(
  LEGAL_ENTITY_FIELDS.map(field => [field, visibility]),
) as Record<LegalEntityField, typeof visibility>).strict();
const inputSchema = valuesSchema.extend({
  schema: z.literal(LEGAL_ENTITY_SCHEMA),
  visibility: visibilitySchema,
}).strict();

export type LegalEntityValues = z.infer<typeof valuesSchema>;
export type LegalEntityInput = LegalEntityValues & {
  schema: typeof LEGAL_ENTITY_SCHEMA;
  visibility: LegalEntityVisibilityMap;
};
export class LegalEntityValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
  }
}

export function validateLegalEntityInput(input: unknown): LegalEntityInput {
  const result = inputSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const suffix = issue.code === 'unrecognized_keys' ? issue.keys[0] : undefined;
    throw new LegalEntityValidationError([...issue.path, ...(suffix ? [suffix] : [])].join('.') || 'legalEntity', issue.message);
  }
  return result.data as LegalEntityInput;
}


export function legalEntityFieldValue(values: LegalEntityValues, field: LegalEntityField): string | undefined {
  if (field === 'legalName' || field === 'operatingName') return values[field];
  return values.address[field.slice('address.'.length) as keyof LegalEntityValues['address']];
}
