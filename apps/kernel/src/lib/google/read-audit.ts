import { publish } from '@imajin/bus';
import { currentConnectionSlot } from '../kernel/connector-connection-context';
type GoogleReadOperation =
  | 'search-console.sites.list'
  | 'search-console.searchAnalytics.query'
  | 'search-console.urlInspection.inspect'
  | 'business-profile.locations.list'
  | 'business-profile.reviews.list';

/** Only operation provenance, never provider results, URLs, queries or review PII. */
export async function publishGoogleRead(ownerDid: string, operation: GoogleReadOperation): Promise<void> {
  const result = await publish('google.data.read', {
    issuer: ownerDid,
    subject: ownerDid,
    scope: 'google',
    payload: {
      ownerDid,
      onBehalfOf: ownerDid,
      slot: currentConnectionSlot('google', ownerDid),
      operation,
      context_id: ownerDid,
      context_type: 'google',
    },
  });
  // publish() intentionally tolerates reactor failures, so awaiting it alone
  // does not establish that the signed provenance was persisted.
  if (typeof result?.attestationId !== 'string' || !result.attestationId.trim()) {
    throw new Error('google_read_audit_unavailable: signed Google read provenance could not be recorded');
  }
}
