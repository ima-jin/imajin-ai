import { broker, isBrokerRelease } from '@imajin/bus';
import type { ReleasePolicy } from '../media/release-policy';
import {
  LEGAL_ENTITY_FIELDS, legalEntityFieldValue,
  type LegalEntityField, type LegalEntityValues,
} from './legal-entity-schema';

export const LEGAL_ENTITY_DISCLOSURE_PURPOSE = 'legal-entity.disclosure';
export type ReleasedLegalEntity = Partial<Omit<LegalEntityValues, 'address'>> & {
  address?: Partial<LegalEntityValues['address']>;
};

function setField(result: ReleasedLegalEntity, field: LegalEntityField, value: string): void {
  if (field === 'legalName' || field === 'operatingName') {
    result[field] = value;
  } else {
    result.address ??= {};
    result.address[field.slice('address.'.length) as keyof LegalEntityValues['address']] = value;
  }
}

/** No owner bypass: never means never. Owner editing uses a separate authorized read. */
export async function releaseLegalEntity(
  did: string,
  viewerDid: string | null,
  values: LegalEntityValues,
  policy: ReleasePolicy,
): Promise<ReleasedLegalEntity> {
  const result: ReleasedLegalEntity = {};
  for (const field of LEGAL_ENTITY_FIELDS) {
    const rule = policy[field];
    const value = legalEntityFieldValue(values, field);
    if (!rule || value === undefined || (rule.viewer && rule.viewer !== viewerDid)) continue;
    if (rule.release === 'silent') setField(result, field, value);
    if (rule.release !== 'on-consent' || !viewerDid) continue;
    try {
      const released = await broker('legal-entity.field.request', {
        type: 'legal-entity.field.request',
        requester: viewerDid,
        subject: did,
        scope: 'profile',
        purpose: LEGAL_ENTITY_DISCLOSURE_PURPOSE,
        fields: [field],
        data: { [field]: value },
      });
      // Attestation-mode consent is NOT consent to release raw legal values.
      if (isBrokerRelease(released) && released.enforced !== false
        && (released.envelope.fieldModes?.[field] ?? released.envelope.mode) === 'raw'
        && typeof released.data[field] === 'string') {
        setField(result, field, released.data[field] as string);
      }
    } catch {
      // Broker unavailable => field stays absent. Never substitute source data.
    }
  }
  return result;
}
