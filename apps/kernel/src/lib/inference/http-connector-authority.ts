import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { hasActiveVaultGrant } from '@/src/lib/vault/active-grant-policy';

interface HttpAuthority {
  grant: (ownerDid: string, scope: string) => Promise<boolean>;
  fields: (ownerDid: string) => string[];
  grantee?: string;
}

/** Adapters contain no authorization policy: each predicate is the connector's call gate. */
export async function httpConnectorAuthority(provider: string): Promise<HttpAuthority | undefined> {
  switch (provider) {
    case 'github': {
      const c = await import('@/src/lib/github/connector');
      return { grant: c.resolveActiveGrant, fields: did => [c.oauthVaultField(did), c.vaultField(did)] };
    }
    case 'google': {
      const c = await import('@/src/lib/google/connector');
      return {
        grant: async (did, scope) => (await c.readGoogleScopeAuthority(did, scope)).granted,
        fields: did => [c.oauthVaultField(did)],
      };
    }
    case 'quickbooks': {
      const c = await import('@/src/lib/quickbooks/connector');
      return { grant: c.resolveActiveGrant, fields: did => [c.vaultField(did)] };
    }
    case 'discord': {
      const c = await import('@/src/lib/discord/connector');
      return { grant: c.resolveActiveGrant, fields: did => [c.vaultField(did)] };
    }
    case 'typesafe': {
      const c = await import('@/src/lib/typesafe/connector');
      return { grant: c.resolveActiveGrant, fields: did => [c.vaultField(did)] };
    }
    case 'gcp': {
      const c = await import('@/src/lib/gcp/connector');
      return { grant: c.resolveActiveGrant, fields: did => [c.vaultField(did)] };
    }
    case 'stripe': {
      const { stripe } = await import('@/src/lib/stripe/connector-core');
      return { grant: stripe.resolveActiveGrant, fields: did => [stripe.vaultField(did)] };
    }
    case 'warp': {
      const c = await import('@/src/lib/warp/connector');
      return {
        grant: c.warpConnector.resolveActiveGrant, fields: did => [c.warpKeyField(did)],
        grantee: c.WARP_CONNECTOR_DID,
      };
    }
  }
}

/** No vault service/get/peek: readiness is grant metadata, not a live credential probe. */
export async function httpCredentialAuthorized(authority: HttpAuthority, ownerDid: string) {
  const grantee = authority.grantee ?? getNodeSigningIdentity().senderDid;
  for (const field of authority.fields(ownerDid)) {
    if (await hasActiveVaultGrant(field, grantee)) return true;
  }
  return false;
}
