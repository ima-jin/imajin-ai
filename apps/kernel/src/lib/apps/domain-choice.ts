/** Client-safe provision choices shared by the API and /jin panel. */
import { APP_VISIBILITY_ERROR, isAppVisibility } from './visibility';
import { APP_SIGN_IN_AUDIENCE_ERROR, isAppSignInAudience } from './sign-in-audience';
import { isRepositoryName } from './template-lineage';

export interface ProvisionDomainChoice {
  signInAudience?: unknown;
  visibility?: unknown;
  sourceRepo?: unknown;
  siteOwnerDid?: unknown;
  domain?: unknown;
  reissueClaim?: unknown;
}

export function isSiteOwnerDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[a-z0-9]+:[A-Za-z0-9:._-]{1,200}$/.test(value);
}

export function isProvisionDomain(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.imajin\.ai$/.test(value);
}

function validateAudienceChoice(body: ProvisionDomainChoice): string | null {
  if (body.signInAudience !== undefined && !isAppSignInAudience(body.signInAudience)) return APP_SIGN_IN_AUDIENCE_ERROR;
  if (body.reissueClaim === true && Object.hasOwn(body, 'signInAudience')) return 'Reissuing a claim cannot change signInAudience';
  return null;
}

export function validateDomainChoice(body: ProvisionDomainChoice): string | null {
  const audienceError = validateAudienceChoice(body);
  if (audienceError) return audienceError;
  if (body.visibility !== undefined && !isAppVisibility(body.visibility)) return APP_VISIBILITY_ERROR;
  if (body.reissueClaim === true && Object.hasOwn(body, 'sourceRepo')) {
    return 'Reissuing a claim cannot change sourceRepo';
  }
  if (body.sourceRepo !== undefined && !isRepositoryName(body.sourceRepo)) {
    return 'sourceRepo must be an owner/name repository identifier';
  }
  if (body.siteOwnerDid !== undefined && (
    !isSiteOwnerDid(body.siteOwnerDid)
  )) return 'siteOwnerDid must be a DID';
  if (body.domain !== undefined && (
    !isProvisionDomain(body.domain)
  )) return 'domain must be a direct imajin.ai subdomain; custom domains require TXT verification';
  if (body.reissueClaim === true && (body.siteOwnerDid !== undefined || body.domain !== undefined || body.visibility !== undefined)) {
    return 'Reissuing a claim cannot change ownership, domain or visibility';
  }
  return null;
}

