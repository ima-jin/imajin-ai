import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize as canonicalizeManifest } from '../../../../../../packages/fair/src/canonical';
import { canonicalize as canonicalizeAttestation } from '../../../../../../packages/auth/src/sign';
import { provideInternalApiKey } from '../../../../../../packages/auth/src/internal-post';

const h = vi.hoisted(() => ({
  assets: {},
  attestations: {},
  assetRows: [] as Record<string, unknown>[],
  attestationRows: [] as Record<string, unknown>[],
  signSync: vi.fn(() => 'fixture-attestation-signature'),
  requireInternalApiKey: vi.fn(async (_request: unknown) => null),
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/db', () => ({
  assets: h.assets,
  attestations: h.attestations,
  assetFolders: {},
  identities: {},
  registryApps: {},
  db: {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === h.assets) h.assetRows.push(row);
        else if (table === h.attestations) h.attestationRows.push(row);
        else throw new Error('Unexpected integration-test insert');
        return { returning: async () => [{ ...row }] };
      },
    }),
  },
}));

// Keep the real forwarder/transport and vocabulary without importing the auth
// index's unrelated session, vault, and service dependencies.
vi.mock('@imajin/auth', async () => {
  const emitter = await import('../../../../../../packages/auth/src/emit-attestation');
  const signing = await import('../../../../../../packages/auth/src/sign');
  const types = await import('../../../../../../packages/auth/src/types/attestation');
  const funnel = await import('../../../../../../packages/auth/src/intro-funnel');
  return {
    ...emitter,
    ...types,
    ...funnel,
    canonicalize: signing.canonicalize,
    crypto: { signSync: h.signSync },
    hexToBytes: () => new Uint8Array(32),
    KEY_ROTATED_ATTESTATION_TYPE: 'key.rotated',
    verifyNostrSig: vi.fn(),
    buildAttestDelegationCapability: vi.fn(),
  };
});

vi.mock('@/src/lib/auth/require-internal-api-key', () => ({
  requireInternalApiKey: h.requireInternalApiKey,
}));
vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  isRegisteredAttestationType: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: h.publish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/src/lib/media/blob-store-lore', () => ({
  blobStore: { put: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/src/lib/media/folders', () => ({ getOrCreateSystemFolder: vi.fn() }));
vi.mock('@/src/lib/media/classify', () => ({ classifyAsset: vi.fn() }));
vi.mock('@/src/lib/media/article-core', () => ({
  deriveArticleProjection: vi.fn(),
  mergeArticleMetadata: vi.fn(),
}));
vi.mock('@imajin/dfos', () => ({
  publishContentEvent: vi.fn().mockResolvedValue(null),
}));
vi.mock('@imajin/cid', () => ({
  computeCid: vi.fn().mockResolvedValue('bafy-upload-integration-fixture'),
}));
vi.mock('@imajin/fair', async () => {
  const canonical = await import('../../../../../../packages/fair/src/canonical');
  const templates = await import('../../../../../../packages/fair/src/templates');
  return {
    ...canonical,
    getDefaultManifest: templates.getDefaultManifest,
    // A visibly signed fixture ensures the digest binds the persisted signed
    // manifest, not its unsigned template or pretty-printed filesystem bytes.
    signManifest: vi.fn(async (manifest: Record<string, unknown>, signer: { did: string }) => ({
      ...manifest,
      signature: { signer: signer.did, alg: 'ed25519', value: 'fixture-manifest-signature' },
    })),
  };
});

import { POST } from '@/app/auth/api/attestations/internal/route';
import { createAsset } from '../create-asset';

const PLATFORM_DID = 'did:imajin:fixture-platform';
const OWNER_DID = 'did:imajin:fixture-owner';
const BASE_URL = 'https://media.example.test';
const AUTH_URL = 'https://auth.example.test/auth';
const INTERNAL_KEY = 'integration-test-internal-key';
const PRIVATE_KEY_SENTINEL = 'integration-test-not-a-private-key';
const CONTENT = Buffer.from('An upload with attributable provenance.\n');
const vaultKeySymbol = Symbol.for('@imajin/auth/vault-attestation-internal-api-key');
let previousVaultKeyState: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  h.assetRows.length = 0;
  h.attestationRows.length = 0;
  vi.stubEnv('PLATFORM_DID', PLATFORM_DID);
  vi.stubEnv('AUTH_PRIVATE_KEY', PRIVATE_KEY_SENTINEL);
  vi.stubEnv('AUTH_SERVICE_URL', AUTH_URL);
  previousVaultKeyState = Object.getOwnPropertyDescriptor(globalThis, vaultKeySymbol);
  provideInternalApiKey(INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (previousVaultKeyState) Object.defineProperty(globalThis, vaultKeySymbol, previousVaultKeyState);
  else Reflect.deleteProperty(globalThis, vaultKeySymbol);
});

describe('media.uploaded — createAsset → emitAttestation → internal POST (#2276)', () => {
  it.each([
    { uploadedBy: 'did:imajin:fixture-uploader', expectedUploader: 'did:imajin:fixture-uploader' },
    { uploadedBy: undefined, expectedUploader: OWNER_DID },
  ])('stores a signed upload fact with uploader $expectedUploader', async ({ uploadedBy, expectedUploader }) => {
    const internalResponses: number[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === `${AUTH_URL}/api/attestations/internal`) {
        const response = await POST(new NextRequest(String(url), init));
        internalResponses.push(response.status);
        return response;
      }
      if (String(url) === `${AUTH_URL}/api/attestations/chain-emit`) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected integration-test fetch: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAsset({
      ownerDid: OWNER_DID,
      uploadedBy,
      buffer: CONTENT,
      filename: 'provenance.txt',
      mimeType: 'text/plain',
      baseUrl: BASE_URL,
      dedup: false,
      classify: false,
    });

    expect(result.deduplicated).toBe(false);
    expect(h.assetRows).toHaveLength(1);
    // Upload attestation delivery is intentionally fire-and-forget.
    await vi.waitFor(() => expect(internalResponses).toEqual([201]));
    expect(h.attestationRows).toHaveLength(1);

    const asset = h.assetRows[0];
    const row = h.attestationRows[0];
    const assetDid = `did:imajin:${result.asset.id}`;
    const manifest = asset.fairManifest as Record<string, unknown>;
    const payload = {
      asset_did: assetDid,
      uploader_did: expectedUploader,
      owner_did: OWNER_DID,
      fair_manifest_ref: `${BASE_URL}/media/api/assets/${result.asset.id}/fair`,
      fair_manifest_digest: `sha256:${createHash('sha256').update(canonicalizeManifest(manifest)).digest('hex')}`,
      content_hash: createHash('sha256').update(CONTENT).digest('hex'),
    };
    expect(manifest.signature).toMatchObject({ value: 'fixture-manifest-signature' });
    const manifestWrite = vi.mocked(writeFile).mock.calls.find(([path]) => String(path).endsWith('.fair.json'));
    expect(manifestWrite).toBeDefined();
    expect(JSON.parse(String(manifestWrite![1]))).toEqual(manifest);
    expect(row).toMatchObject({
      id: expect.stringMatching(/^att_/),
      issuerDid: PLATFORM_DID,
      subjectDid: assetDid,
      type: 'media.uploaded',
      contextId: result.asset.id,
      contextType: 'media',
      payload,
      signature: 'fixture-attestation-signature',
      issuedAt: expect.any(Date),
    });
    expect(row.payload).toEqual(payload);
    expect(h.signSync).toHaveBeenCalledTimes(1);
    expect(h.signSync).toHaveBeenCalledWith(
      canonicalizeAttestation({
        subject_did: assetDid,
        type: 'media.uploaded',
        context_id: result.asset.id,
        context_type: 'media',
        payload,
        issued_at: (row.issuedAt as Date).getTime(),
      }),
      PRIVATE_KEY_SENTINEL,
    );
    expect(h.requireInternalApiKey).toHaveBeenCalledTimes(1);
    const forwardedRequest = h.requireInternalApiKey.mock.calls[0][0] as NextRequest;
    expect(forwardedRequest.headers.get('authorization')).toBe(`Bearer ${INTERNAL_KEY}`);
    expect(h.publish).toHaveBeenCalledWith('attestation.created', expect.objectContaining({
      subject: assetDid,
      payload: expect.objectContaining({ type: 'media.uploaded', pendingSignature: false }),
    }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/api/attestations/chain-emit`,
      expect.objectContaining({ method: 'POST' }),
    ));
  });
});
