/**
 * GET + POST /gcp/api/token (#1317)
 *
 * Pattern B credential ingestion for the Google Cloud connector, wired through
 * the shared token-paste route factory. The pasted credential is a GCP
 * service-account key JSON, sealed verbatim — the kernel does not parse it, so
 * nothing about its contents leaks into logs or responses.
 *
 * Security invariants (enforced by the factory): the key is never logged, never
 * returned, never echoed, and per-DID isolation comes from
 * `gcp-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, gcpKeySealed } from '@/src/lib/gcp/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Google Cloud',
  sealApiKey,
  keySealed: gcpKeySealed,
});
