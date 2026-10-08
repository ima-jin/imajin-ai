/**
 * Known vault fields (#2700) — the fields the kernel's own code reads by a
 * fixed name, served by `GET /api/vault/known-fields` so the /jin vault panel
 * learns them from the kernel instead of carrying a hardcoded list.
 *
 * Server-only (imports org-provisioning.ts, which pulls in
 * node:crypto) — never import this from a client component. Clients get this
 * data over the API.
 *
 * Every entry's `name` is built from the same exported constant the real
 * reader uses (`GITHUB_ORG_CREDENTIAL_FIELD`, `internalSecretField(...)`), so
 * the registry cannot invent a field name that drifts from what the kernel
 * actually looks up. The registry holds names and prose only — never values.
 */
import { GITHUB_ORG_CREDENTIAL_FIELD } from '@/src/lib/github/org-provisioning';
import { ATTESTATION_INTERNAL_API_KEY_PURPOSE } from '@/src/lib/auth/require-internal-api-key';
import { PEPPER_PURPOSE } from '@/src/lib/auth/foreign-principal-stub';
import { VAPID_KEYS_PURPOSE } from '@/src/lib/notify/vapid';
import { internalSecretField } from './internal-secret';

/** Grouping a known field belongs to: where the kernel reads it from. */
export type KnownVaultFieldNamespace = 'github' | 'internal-secret';

export interface KnownVaultField {
  /** The exact vault field name the kernel looks up. */
  readonly name: string;
  /** Short human-readable title for display. */
  readonly label: string;
  /** What the field is for and who reads it. */
  readonly description: string;
  readonly namespace: KnownVaultFieldNamespace;
}

export const KNOWN_VAULT_FIELDS: readonly KnownVaultField[] = Object.freeze([
  {
    name: GITHUB_ORG_CREDENTIAL_FIELD,
    label: 'GitHub org credential',
    description:
      'Org-scoped GitHub App installation credential apps.provision uses to create app repos and seal their deploy secrets.',
    namespace: 'github',
  },
  {
    name: internalSecretField(ATTESTATION_INTERNAL_API_KEY_PURPOSE),
    label: 'Internal API key',
    description: 'Bearer key requireInternalApiKey() checks for internal kernel-to-kernel calls.',
    namespace: 'internal-secret',
  },
  {
    name: internalSecretField(PEPPER_PURPOSE),
    label: 'Foreign-principal pepper',
    description: 'HMAC pepper for foreign-principal stub refs.',
    namespace: 'internal-secret',
  },
  {
    name: internalSecretField(VAPID_KEYS_PURPOSE),
    label: 'Web Push VAPID keys',
    description: 'Web Push VAPID keypair for browser push notifications.',
    namespace: 'internal-secret',
  },
]);
