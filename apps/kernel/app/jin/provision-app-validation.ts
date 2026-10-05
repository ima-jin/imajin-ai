/**
 * Client-side validation for the /jin "Provision app" form (#2559). Mirrors
 * the limits in `POST /api/apps/provision` (`app/api/apps/provision/route.ts`)
 * so a bad value is refused before anything is proposed; the route still
 * validates server-side and stays the authority.
 */

export const DEFAULT_APP_TEMPLATE = 'ima-jin/imajin-app-template';

/** Same pattern as the route's `SLUG_PATTERN` — a repo-safe, lowercase, hyphenated identifier. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_TEMPLATE_LENGTH = 200;
export const MAX_ATTESTATION_TYPES = 20;

export interface ProvisionFormValues {
  slug: string;
  displayName: string;
  template: string;
  /** Raw textarea/input text — comma- or whitespace-separated `<slug>/<type>` entries. */
  attestationTypes: string;
}

export interface ProvisionFormErrors {
  slug?: string;
  displayName?: string;
  template?: string;
  attestationTypes?: string;
}

export interface ProvisionPayload {
  slug: string;
  displayName: string;
  template: string;
  attestationTypes: string[];
}

/** Split the raw attestation-types text on commas/whitespace, dropping blanks and duplicates. */
export function parseAttestationTypes(raw: string): string[] {
  const entries = raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
  return [...new Set(entries)];
}

function attestationTypesError(types: readonly string[], slug: string, slugValid: boolean): string | undefined {
  if (types.length > MAX_ATTESTATION_TYPES) {
    return `At most ${MAX_ATTESTATION_TYPES} attestation types`;
  }
  for (const type of types) {
    const separatorIndex = type.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === type.length - 1) {
      return `'${type}' must look like <slug>/<type>`;
    }
    if (slugValid && type.slice(0, separatorIndex) !== slug) {
      return `'${type}' must start with '${slug}/'`;
    }
  }
  return undefined;
}

export function validateProvisionForm(values: ProvisionFormValues): ProvisionFormErrors {
  const errors: ProvisionFormErrors = {};
  const slug = values.slug.trim();
  const displayName = values.displayName.trim();
  const template = values.template.trim();

  const slugValid = SLUG_PATTERN.test(slug);
  if (!slugValid) {
    errors.slug = "Slug must be lowercase letters, digits and hyphens, starting with a letter (max 39 chars), e.g. 'coffee'";
  }
  if (displayName.length === 0) {
    errors.displayName = 'Display name is required';
  } else if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`;
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    errors.template = `Template must be at most ${MAX_TEMPLATE_LENGTH} characters`;
  }
  const typesError = attestationTypesError(parseAttestationTypes(values.attestationTypes), slug, slugValid);
  if (typesError) {
    errors.attestationTypes = typesError;
  }
  return errors;
}

export function hasProvisionErrors(errors: ProvisionFormErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/** Request body for `POST /api/apps/provision`. Call only after `validateProvisionForm` came back clean. */
export function buildProvisionPayload(values: ProvisionFormValues): ProvisionPayload {
  return {
    slug: values.slug.trim(),
    displayName: values.displayName.trim(),
    template: values.template.trim() || DEFAULT_APP_TEMPLATE,
    attestationTypes: parseAttestationTypes(values.attestationTypes),
  };
}
