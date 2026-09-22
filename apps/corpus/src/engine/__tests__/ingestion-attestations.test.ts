import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { CorpusEngine } from '../index';
import { AttestationNotFoundError } from '../errors';
import { bootstrapCorpusIdentity, _resetCorpusIdentityStateForTests } from '../../lib/corpus-identity';
import type { ThreadDocument } from '../types';

const ORIGINAL_CORPUS_DID = process.env.CORPUS_DID;
const ORIGINAL_CORPUS_DID_PRIVATE_KEY = process.env.CORPUS_DID_PRIVATE_KEY;
const ORIGINAL_AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
const ORIGINAL_ATTESTATION_KEY = process.env.ATTESTATION_INTERNAL_API_KEY;

const CORPUS_KEYPAIR = authCrypto.generateKeypair();

function doc(overrides: Partial<ThreadDocument> = {}): ThreadDocument {
  return {
    source: 'github:ima-jin/imajin-ai',
    sourceType: 'github',
    id: overrides.id ?? '1',
    type: 'issue',
    title: overrides.title ?? 'Title',
    state: 'open',
    labels: [],
    author: 'octocat',
    created: '2026-08-09T15:00:00.000Z',
    updated: overrides.updated ?? '2026-08-09T16:00:00.000Z',
    linkedRefs: [],
    body: overrides.body ?? 'Body',
    comments: [],
    ...overrides,
  };
}

function setCorpusIdentityEnv(): void {
  process.env.CORPUS_DID = 'did:imajin:corpus-service-test';
  process.env.CORPUS_DID_PRIVATE_KEY = CORPUS_KEYPAIR.privateKey;
}

function restoreEnv(): void {
  if (ORIGINAL_CORPUS_DID === undefined) delete process.env.CORPUS_DID;
  else process.env.CORPUS_DID = ORIGINAL_CORPUS_DID;
  if (ORIGINAL_CORPUS_DID_PRIVATE_KEY === undefined) delete process.env.CORPUS_DID_PRIVATE_KEY;
  else process.env.CORPUS_DID_PRIVATE_KEY = ORIGINAL_CORPUS_DID_PRIVATE_KEY;
  if (ORIGINAL_AUTH_SERVICE_URL === undefined) delete process.env.AUTH_SERVICE_URL;
  else process.env.AUTH_SERVICE_URL = ORIGINAL_AUTH_SERVICE_URL;
  if (ORIGINAL_ATTESTATION_KEY === undefined) delete process.env.ATTESTATION_INTERNAL_API_KEY;
  else process.env.ATTESTATION_INTERNAL_API_KEY = ORIGINAL_ATTESTATION_KEY;
}

describe('CorpusEngine ingestion attestations (#1750)', () => {
  let dataDir: string;
  let engine: CorpusEngine;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-attestations-'));
    engine = new CorpusEngine({ dataDir, now: () => new Date('2026-09-01T00:00:00.000Z') });
    delete process.env.CORPUS_DID;
    delete process.env.CORPUS_DID_PRIVATE_KEY;
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it('ingest succeeds and returns no attestationId when no corpus identity is configured', async () => {
    const result = engine.ingest('did:example:alice', [doc()]);
    expect(result).toEqual({ ingested: 1 });

    const search = await engine.search('did:example:alice', { query: 'Title' });
    expect(search.results[0].attestationId).toBeUndefined();

    const status = engine.status('did:example:alice');
    expect(status.attestations).toEqual({ total: 0, pendingForward: 0 });
  });

  it('signs and persists an attestation, and surfaces attestationId on the matching search hit', async () => {
    setCorpusIdentityEnv();

    engine.ingest('did:example:alice', [doc({ id: '1', title: 'Signed doc' })], undefined, 'did:example:ingester');

    const search = await engine.search('did:example:alice', { query: 'Signed' });
    expect(search.results).toHaveLength(1);
    const attestationId = search.results[0].attestationId;
    expect(attestationId).toBeDefined();

    const view = engine.getAttestation('did:example:alice', attestationId as string);
    expect(view.attestation).toMatchObject({
      id: attestationId,
      source: 'github:ima-jin/imajin-ai',
      corpusDid: 'did:example:alice',
      ingesterDid: 'did:example:ingester',
      threadCount: 1,
    });
    expect(view.corpusPublicKey).toBe(CORPUS_KEYPAIR.publicKey);
  });

  it('throws AttestationNotFoundError for an unknown id, and for an id that exists under a different DID', async () => {
    setCorpusIdentityEnv();
    engine.ingest('did:example:alice', [doc({ id: '1' })]);

    const search = await engine.search('did:example:alice', { query: 'Title' });
    const attestationId = search.results[0].attestationId as string;

    expect(() => engine.getAttestation('did:example:alice', 'ing_does_not_exist')).toThrow(AttestationNotFoundError);
    // DID isolation: the same id does not resolve under a different DID's corpus.
    expect(() => engine.getAttestation('did:example:bob', attestationId)).toThrow(AttestationNotFoundError);
  });

  it('records a failed forward as pending and retries it on the next ingest', async () => {
    setCorpusIdentityEnv();
    process.env.AUTH_SERVICE_URL = 'http://kernel.test';
    process.env.ATTESTATION_INTERNAL_API_KEY = 'test-key';

    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    engine.ingest('did:example:alice', [doc({ id: '1' })]);

    await vi.waitFor(() => {
      expect(engine.status('did:example:alice').attestations).toEqual({ total: 1, pendingForward: 1 });
    });

    // Next ingest retries the still-pending attestation, this time succeeding.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: 'att_kernel1' }), { status: 201 }));
    engine.ingest('did:example:alice', [doc({ id: '2', title: 'Second doc' })]);

    await vi.waitFor(() => {
      expect(engine.status('did:example:alice').attestations).toEqual({ total: 2, pendingForward: 0 });
    });
  });

  it('keeps ingesting successfully even when every forward attempt fails', async () => {
    setCorpusIdentityEnv();
    process.env.AUTH_SERVICE_URL = 'http://kernel.test';
    process.env.ATTESTATION_INTERNAL_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = engine.ingest('did:example:alice', [doc({ id: '1' })]);
    expect(result).toEqual({ ingested: 1 });

    await vi.waitFor(() => {
      expect(engine.status('did:example:alice').attestations.pendingForward).toBe(1);
    });
  });
});

describe('CorpusEngine + vault-sourced identity grant ack (#2257)', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  const GRANT_ID = 'vdg_engine_test';
  const BOOTSTRAP_DID = 'did:imajin:engine-bootstrap00';
  const BOOTSTRAP_PRIVATE_KEY = 'd'.repeat(64);
  const BEARER_TOKEN = 'imajin_tok_engine-test';

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  function ackCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
    return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/ack')) as [string, RequestInit][];
  }

  function fakeVaultFetch() {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
      if (url.endsWith('/api/authenticate')) return jsonResponse({ token: BEARER_TOKEN });
      if (url.includes('/fetch')) {
        return jsonResponse({ ok: true, field: `vault-minted-key:${CORPUS_KEYPAIR.publicKey}`, value: CORPUS_KEYPAIR.privateKey, oneTime: true });
      }
      if (url.includes('/ack')) return jsonResponse({ ok: true, grantId: GRANT_ID, outcome: 'used', ackedAt: new Date().toISOString() });
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-attestations-vault-'));
    engine = new CorpusEngine({ dataDir, now: () => new Date('2026-09-01T00:00:00.000Z') });
    delete process.env.CORPUS_DID;
    delete process.env.CORPUS_DID_PRIVATE_KEY;
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    process.env.CORPUS_VAULT_GRANT_ID = GRANT_ID;
    process.env.CORPUS_VAULT_BOOTSTRAP_DID = BOOTSTRAP_DID;
    process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY = BOOTSTRAP_PRIVATE_KEY;
    process.env.AUTH_SERVICE_URL = 'https://kernel.test';
    _resetCorpusIdentityStateForTests();
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env.CORPUS_VAULT_GRANT_ID;
    delete process.env.CORPUS_VAULT_BOOTSTRAP_DID;
    delete process.env.CORPUS_VAULT_BOOTSTRAP_PRIVATE_KEY;
    _resetCorpusIdentityStateForTests();
    restoreEnv();
  });

  it('the first successful sign sends exactly one "used" ack, and later ingests never ack again', async () => {
    const fetchMock = fakeVaultFetch();
    vi.stubGlobal('fetch', fetchMock);
    await bootstrapCorpusIdentity();

    expect(ackCalls(fetchMock)).toHaveLength(0); // no ack at fetch/boot time (#2257)

    engine.ingest('did:example:alice', [doc({ id: '1', title: 'Signed doc' })]);
    await vi.waitFor(() => expect(ackCalls(fetchMock)).toHaveLength(1));
    const [, init] = ackCalls(fetchMock)[0]!;
    expect(JSON.parse(init.body as string)).toMatchObject({ outcome: 'used' });

    // A second batch signs again, but must not send a second ack for the same grant.
    engine.ingest('did:example:alice', [doc({ id: '2', title: 'Second doc' })]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ackCalls(fetchMock)).toHaveLength(1);
  });
});
