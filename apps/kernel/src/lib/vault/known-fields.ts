/**
 * Known vault fields (#2445 defect 4) — the fields the kernel's own code
 * reads by a fixed name, surfaced by `GET /api/vault/known-fields` to the
 * admin panel as add-dialog suggestions and as "missing" table rows.
 *
 * Server-only (imports org-provisioning.ts, which pulls in libsodium and
 * node:crypto) — never import this from a client component. The panel gets
 * this data over the API, not by importing this module directly.
 *
 * Every entry's `field` is built from the same exported constant the real
 * reader uses (`GITHUB_ORG_CREDENTIAL_FIELD`, `internalSecretField(...)`) —
 * this registry does not invent a field name of its own that could drift
 * from what the kernel actually looks up.
 */
import { GITHUB_ORG_CREDENTIAL_FIELD } from '@/src/lib/github/org-provisioning';
import { ATTESTATION_INTERNAL_API_KEY_PURPOSE } from '@/src/lib/auth/require-internal-api-key';
import { PEPPER_PURPOSE } from '@/src/lib/auth/foreign-principal-stub';
import { VAPID_KEYS_PURPOSE } from '@/src/lib/notify/vapid';
import { internalSecretField } from './internal-secret';
import type { VaultCustodyScheme } from './field-grammar';

export interface KnownVaultField {
  field: string;
  description: string;
  requiredCustody?: VaultCustodyScheme;
  why?: string;
}

export const KNOWN_VAULT_FIELDS: readonly KnownVaultField[] = [
  {
    field: GITHUB_ORG_CREDENTIAL_FIELD,
    description:
      'Org-scoped GitHub App installation credential apps.provision uses to create app repos and seal their deploy secrets (#2375, #2416).',
    requiredCustody: 'delegation-grant',
    why: 'org-provisioning.ts (loadOrgCredential) reads this only through the v2 delegation-grant path.',
  },
  {
    field: internalSecretField(ATTESTATION_INTERNAL_API_KEY_PURPOSE),
    description: 'Bearer key requireInternalApiKey() checks for internal kernel-to-kernel calls (#1999/#2245).',
    requiredCustody: 'delegation-grant',
    why: 'self-provisioned via getInternalSecret() — read only through the v2 self-grant path (internal-secret.ts).',
  },
  {
    field: internalSecretField(PEPPER_PURPOSE),
    description: 'HMAC pepper for foreign-principal stub refs (#2251).',
    requiredCustody: 'delegation-grant',
    why: 'same self-grant model as the other internal-secret:* fields.',
  },
  {
    field: internalSecretField(VAPID_KEYS_PURPOSE),
    description: 'Web Push VAPID keypair for browser push notifications.',
    requiredCustody: 'delegation-grant',
    why: 'same self-grant model as the other internal-secret:* fields.',
  },
];
