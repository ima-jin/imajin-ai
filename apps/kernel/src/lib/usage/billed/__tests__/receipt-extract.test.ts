import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveAsset: vi.fn(),
  resolveBrain: vi.fn(),
  readFile: vi.fn(),
  generateText: vi.fn(),
  getModel: vi.fn(),
  dbInsert: vi.fn(),
  emitMechanicalAttestation: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
}));

vi.mock('@imajin/llm', () => ({
  getModel: mocks.getModel,
}));

vi.mock('@/src/lib/media/queries', () => ({
  getActiveAsset: mocks.getActiveAsset,
}));

// Real NoBrainSealedError/NoModelSelectedError classes matter for instanceof
// checks, so only resolveBrain itself is mocked.
vi.mock('@/src/lib/inference/brain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/inference/brain')>();
  return { ...actual, resolveBrain: mocks.resolveBrain };
});

// Never-touched write-path spies (#1951 D4 — "never auto-attest" is asserted
// by checking these are NEVER imported/called from the extraction module).
vi.mock('@/src/db', () => ({ db: { insert: mocks.dbInsert }, usageBilled: {} }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

import { extractReceiptDraft } from '../receipt-extract';
import { NoBrainSealedError, NoModelSelectedError } from '@/src/lib/inference/brain';

const OWNER_DID = 'did:imajin:owner';
const IMAGE_ASSET = { id: 'asset_1', ownerDid: OWNER_DID, mimeType: 'image/jpeg', storagePath: '/mnt/media/asset_1.jpg' };
const RESOLVED_BRAIN = { connector: 'local', credentialDid: OWNER_DID, provider: 'openai', modelId: 'qwen2.5vl:7b', apiKey: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveAsset.mockResolvedValue(IMAGE_ASSET);
  mocks.resolveBrain.mockResolvedValue(RESOLVED_BRAIN);
  mocks.readFile.mockResolvedValue(Buffer.from('fake-image-bytes'));
  mocks.getModel.mockReturnValue({ modelId: 'stub-model' });
  mocks.generateText.mockResolvedValue({
    text: JSON.stringify([
      { description: 'Widget', category: 'hardware', amount: '19.99', currency: 'USD', date: '2026-06-01', vendor: 'Acme' },
    ]),
  });
});

describe('extractReceiptDraft — ownership + mime gating', () => {
  it('returns asset_not_found and never resolves a brain when the asset does not exist', async () => {
    mocks.getActiveAsset.mockResolvedValue(undefined);

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_missing' });

    expect(result).toEqual({ error: 'asset_not_found' });
    expect(mocks.resolveBrain).not.toHaveBeenCalled();
  });

  it('returns asset_not_owned when the asset belongs to someone else', async () => {
    mocks.getActiveAsset.mockResolvedValue({ ...IMAGE_ASSET, ownerDid: 'did:imajin:someone-else' });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toEqual({ error: 'asset_not_owned' });
    expect(mocks.resolveBrain).not.toHaveBeenCalled();
  });

  it('rejects a non-image mime type before resolving a brain', async () => {
    mocks.getActiveAsset.mockResolvedValue({ ...IMAGE_ASSET, mimeType: 'application/pdf' });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toEqual({ error: 'unsupported_mime_type', mimeType: 'application/pdf' });
    expect(mocks.resolveBrain).not.toHaveBeenCalled();
  });
});

describe('extractReceiptDraft — brain resolution', () => {
  it('resolves the owner brain narrowed to the local connector', async () => {
    await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(mocks.resolveBrain).toHaveBeenCalledWith(OWNER_DID, { connectors: ['local'] });
  });

  it('returns no_local_brain when nothing is sealed', async () => {
    mocks.resolveBrain.mockRejectedValue(new NoBrainSealedError([OWNER_DID], []));

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ error: 'no_local_brain' });
  });

  it('returns no_local_brain when a model is not selected', async () => {
    mocks.resolveBrain.mockRejectedValue(new NoModelSelectedError('Local Inference', '/local/api/token'));

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ error: 'no_local_brain' });
  });
});

describe('extractReceiptDraft — never writes or attests (D4)', () => {
  it('never touches usage.billed or the attestation primitive on success', async () => {
    await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(mocks.dbInsert).not.toHaveBeenCalled();
    expect(mocks.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('never touches usage.billed or the attestation primitive on failure', async () => {
    mocks.generateText.mockRejectedValue(new Error('upstream 500'));

    await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(mocks.dbInsert).not.toHaveBeenCalled();
    expect(mocks.emitMechanicalAttestation).not.toHaveBeenCalled();
  });

  it('returns status "unconfirmed" on success', async () => {
    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ status: 'unconfirmed' });
  });
});

describe('extractReceiptDraft — model output parsing', () => {
  it('parses a well-formed JSON array response into draft lines', async () => {
    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({
      status: 'unconfirmed',
      lines: [{ description: 'Widget', category: 'hardware', amount: '19.99', currency: 'USD', date: '2026-06-01', vendor: 'Acme' }],
    });
  });

  it('strips a markdown code fence the model added despite instructions', async () => {
    mocks.generateText.mockResolvedValue({
      text: '```json\n[{"description":"Widget","category":null,"amount":"5.00","currency":"USD","date":null,"vendor":null}]\n```',
    });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ lines: [{ description: 'Widget', amount: '5.00' }] });
  });

  it('returns extraction_failed for unparseable model output', async () => {
    mocks.generateText.mockResolvedValue({ text: 'not json at all' });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ error: 'extraction_failed' });
  });

  it('returns extraction_failed when the model returns an empty array', async () => {
    mocks.generateText.mockResolvedValue({ text: '[]' });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ error: 'extraction_failed' });
  });

  it('drops malformed candidate lines (missing required fields) rather than throwing', async () => {
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify([
        { description: 'Valid line', amount: '1.00', currency: 'USD' },
        { description: 'Missing amount', currency: 'USD' },
      ]),
    });

    const result = await extractReceiptDraft({ ownerDid: OWNER_DID, assetId: 'asset_1' });

    expect(result).toMatchObject({ lines: [{ description: 'Valid line' }] });
    expect((result as { lines: unknown[] }).lines).toHaveLength(1);
  });
});
