import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { registryApps } from '@/src/db/schemas/registry';
import { appProvisions } from '@/src/db/schemas/app-provisions';
import { identities, identityMembers, attestations } from '@/src/db/schemas/auth';
import { vaultDelegationGrants } from '@/src/db/schemas/vault';
import { profiles, forestConfig } from '@/src/db/schemas/profile';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  issueDomain: vi.fn().mockResolvedValue(undefined),
  claim: vi.fn().mockResolvedValue('fixture-claim-code'),
}));

vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/app-provisions'),
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/profile'),
  ...await import('@/src/db/schemas/vault'),
  db: {
    select: (...args: Parameters<PgliteDatabase['select']>) => h.database!.select(...args),
    insert: (...args: Parameters<PgliteDatabase['insert']>) => h.database!.insert(...args),
    update: (...args: Parameters<PgliteDatabase['update']>) => h.database!.update(...args),
    transaction: (...args: Parameters<PgliteDatabase['transaction']>) => h.database!.transaction(...args),
  },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@imajin/auth')>(),
  emitAttestation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }),
}));
vi.mock('@/src/lib/vault/mint', () => ({
  mintKeypair: vi.fn().mockResolvedValue({ did: 'did:imajin:gbs-app', publicKey: 'fixture-public-key' }),
  emitMintedEvents: vi.fn(),
  mintedKeyField: (did: string) => `vault-minted-key:${did}`,
}));
vi.mock('@/src/lib/vault/key-cards', () => ({ getMintedKeyByDid: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({
  grantExistingMintedKey: vi.fn().mockResolvedValue({ status: 'ok', grantId: 'fixture-grant' }),
  emitGrantEvents: vi.fn(),
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  PROVISIONING_ORG: 'ima-jin',
  DEFAULT_APP_TEMPLATE: 'ima-jin/imajin-app-template',
  ensureRepoFromTemplate: vi.fn().mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/gbs', created: true }),
  tryGetInstallationToken: vi.fn().mockResolvedValue(null),
  fetchAppManifest: vi.fn().mockResolvedValue({ ok: {} }),
  appManifestError: vi.fn(),
}));
vi.mock('../attestation-types', () => ({ seedAttestationTypes: vi.fn() }));
vi.mock('../self-secrets', () => ({ ensureAppDeclaredSecrets: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../signing-key-claims', () => ({
  APP_SIGNING_KEY_PURPOSE: 'app-signing-key', issueSigningKeyClaim: h.claim,
}));
vi.mock('@/src/lib/domains/service', () => ({
  normalizeDomain: (domain: string) => domain, issueImajinDomain: h.issueDomain,
}));
vi.mock('@/src/lib/vault/authorization', () => ({
  resolveVaultAuthorization: () => ({
    operatorDid: 'did:imajin:operator', approvalId: 'fixture-approval',
    contentHash: 'fixture-hash', decidedAt: '2026-10-18T00:00:00.000Z',
  }),
}));

import { executeAppsProvisionApproval } from '../approvals-execution';
import { runAppProvision } from '../provision';
import { resolveAppDirectoryForIdentity, resolveNavAppsForIdentity } from '@/src/lib/kernel/app-nav';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';

vi.setConfig({ testTimeout: 30_000 });
let client: PGlite | undefined;
afterEach(async () => { await client?.close(); client = undefined; vi.unstubAllEnvs(); });

describe('#2935 — one approved provision, no owner PATCH', () => {
  it('registers a private app for a memberless stub, on its own callback host, and follows live org membership', async () => {
    client = new PGlite();
    h.database = drizzle(client);
    // Use the real Drizzle column names/types so registration and directory
    // queries execute in Postgres, rather than testing a copied visibility filter.
    await client.exec('CREATE SCHEMA auth; CREATE SCHEMA registry; CREATE SCHEMA kernel; CREATE SCHEMA profile;');
    for (const table of [registryApps, appProvisions, identities, identityMembers, vaultDelegationGrants, profiles, forestConfig, attestations]) {
      const config = getTableConfig(table);
      const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(', ');
      await client.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns})`);
    }
    await client.exec(`
      ALTER TABLE kernel.app_provisions ALTER secrets_set SET DEFAULT '[]'::jsonb;
      ALTER TABLE kernel.app_provisions ALTER attestation_types SET DEFAULT '[]'::jsonb;
      INSERT INTO auth.identities (id, scope) VALUES
        ('did:imajin:gbs', 'business'), ('did:imajin:member', 'actor'), ('did:imajin:outsider', 'actor');
    `);
    vi.stubEnv('APP_URL', 'https://dev-jin.imajin.ai');
    const result = await executeAppsProvisionApproval({
      proposalId: 'fixture-approval', kind: 'apps:provision', source: 'apps',
      detail: {
        slug: 'gbs', displayName: 'GBS', siteOwnerDid: 'did:imajin:gbs',
        visibility: 'private', domain: 'dev-gbs.imajin.ai',
      },
    } as OperatorApprovalCard);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { appDid: 'did:imajin:gbs-app', claimCode: 'fixture-claim-code' } });
    const [app] = await h.database.select().from(registryApps);
    expect(app).toMatchObject({
      ownerDid: 'did:imajin:gbs', visibility: 'private',
      callbackUrl: 'https://dev-gbs.imajin.ai/api/auth/callback',
      allowedRedirectHosts: ['dev-gbs.imajin.ai'], tokenAudiences: ['gbs'],
      sourceRepo: 'ima-jin/gbs', template: 'ima-jin/imajin-app-template', joined: true,
    });
    expect(await h.database.select().from(identityMembers)).toEqual([]);
    expect(h.issueDomain).toHaveBeenCalledWith({ domain: 'dev-gbs.imajin.ai', appDid: 'did:imajin:gbs-app' });
    expect(await resolveAppDirectoryForIdentity('did:imajin:outsider')).toEqual([]);
    expect(await resolveAppDirectoryForIdentity('did:imajin:member')).toEqual([]);
    expect(await resolveAppDirectoryForIdentity('did:imajin:gbs')).toEqual([expect.objectContaining({ slug: 'gbs', inherited: true })]);

    // No owner PATCH, feature toggle, or separate app add/authorization.
    await client.exec("INSERT INTO auth.identity_members (identity_did, member_did) VALUES ('did:imajin:gbs','did:imajin:member')");
    expect(await resolveAppDirectoryForIdentity('did:imajin:member')).toEqual([expect.objectContaining({ slug: 'gbs', visibility: 'private' })]);
    expect(await resolveNavAppsForIdentity('did:imajin:member')).toEqual([expect.objectContaining({ slug: 'gbs', inherited: true })]);
    expect(await resolveAppDirectoryForIdentity('did:imajin:outsider')).toEqual([]);
    await client.exec("UPDATE auth.identity_members SET removed_at = NOW()");
    expect(await resolveNavAppsForIdentity('did:imajin:member')).toEqual([]);

    expect((await runAppProvision({ slug: 'gbs', displayName: 'GBS' })).status).toBe('succeeded');
    expect(await h.database.select().from(registryApps)).toEqual([app]);
  });
});
