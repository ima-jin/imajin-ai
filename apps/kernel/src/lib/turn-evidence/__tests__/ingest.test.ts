import { describe, it, expect } from 'vitest';
import { buildTurnEvidencePayload, hashToolIo } from '@imajin/auth';
import { ingestTurnEvidence } from '../ingest';
import { createMemoryStore } from './memory-store';
import {
  AGENT_DID,
  AGENT_KEYPAIR,
  OTHER_KEYPAIR,
  PRINCIPAL_DID,
  TURN_EVENT_ID,
  USAGE_ID,
  batchOf,
  evidenceFields,
  signItem,
  signedItem,
} from './helpers';

describe('ingestTurnEvidence — one row per tool call, linked to the turn', () => {
  it('stores one attestation row per item, in the shape the issue specifies', async () => {
    const store = createMemoryStore();
    const items = [signedItem(0), signedItem(1), signedItem(2)];

    const result = await ingestTurnEvidence(batchOf(items), store.ingestDeps);

    expect(result).toEqual({
      ok: true,
      turnEventId: TURN_EVENT_ID,
      inserted: [
        { id: 'att_mem0', seq: 0 },
        { id: 'att_mem1', seq: 1 },
        { id: 'att_mem2', seq: 2 },
      ],
      duplicateSeqs: [],
    });
    expect(store.rows).toHaveLength(3);
    for (const row of store.rows) {
      expect(row.type).toBe('agent.turn.evidence');
      expect(row.issuerDid).toBe(AGENT_DID);
      expect(row.subjectDid).toBe(AGENT_DID);
      expect(row.contextId).toBe(TURN_EVENT_ID); // linked to the turn event
      expect(row.contextType).toBe('agent.turn');
      expect(row.payload.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.payload.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.delegatorDid).toBe(PRINCIPAL_DID);
      expect(row.delegationGrantId).toBe('grant_1');
    }
    expect(store.announce).toHaveBeenCalledTimes(3);
  });

  it('records no delegation when the agent publishes for itself', async () => {
    const store = createMemoryStore();
    const item = signedItem(0, { principalDid: AGENT_DID });

    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);

    expect(result.ok).toBe(true);
    expect(store.rows[0].delegatorDid).toBeNull();
    expect(store.rows[0].delegationGrantId).toBeNull();
  });
});

describe('ingestTurnEvidence — signature and authorization (fail closed, nothing written)', () => {
  it('rejects an unknown agent DID', async () => {
    const store = createMemoryStore({ keys: {} });
    const result = await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'evidence_agent_unknown' });
    expect(store.rows).toHaveLength(0);
  });

  it('rejects a signature made by a different key, naming only the seq', async () => {
    const store = createMemoryStore();
    const forged = signItem(buildTurnEvidencePayload(evidenceFields(1)), OTHER_KEYPAIR.privateKey);
    const result = await ingestTurnEvidence(batchOf([signedItem(0), forged]), store.ingestDeps);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid signature for evidence seq 1',
      code: 'evidence_signature_invalid',
    });
    expect(store.rows).toHaveLength(0); // all-or-nothing: the valid item was not stored either
  });

  it('rejects a payload altered after signing', async () => {
    const store = createMemoryStore();
    const item = signedItem(0);
    const tampered = { ...item, payload: { ...item.payload, outputHash: hashToolIo('something else') } };
    const result = await ingestTurnEvidence(batchOf([tampered]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'evidence_signature_invalid' });
  });

  it('rejects when issued_at differs from the signed value', async () => {
    const store = createMemoryStore();
    const item = signedItem(0);
    const result = await ingestTurnEvidence(batchOf([{ ...item, issuedAt: item.issuedAt + 1 }]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'evidence_signature_invalid' });
  });

  it('accepts an uppercase registered key (case-insensitive hex)', async () => {
    const store = createMemoryStore({ keys: { [AGENT_DID]: AGENT_KEYPAIR.publicKey.toUpperCase() } });
    const result = await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);
    expect(result.ok).toBe(true);
  });

  it('rejects a validly signed batch when the agent has no authority over the principal', async () => {
    const store = createMemoryStore();
    const item = signedItem(0, { principalDid: 'did:imajin:someone-who-never-delegated' });
    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'evidence_publisher_unauthorized' });
    expect(store.rows).toHaveLength(0);
  });
});

describe('ingestTurnEvidence — linkage to usage (#1863)', () => {
  it('accepts a usageRef that is the agent’s own agent.turn.usage attestation', async () => {
    const store = createMemoryStore({ usageIds: [USAGE_ID] });
    const result = await ingestTurnEvidence(
      batchOf([signedItem(0, { usageRef: USAGE_ID }), signedItem(1, { usageRef: USAGE_ID })]),
      store.ingestDeps,
    );
    expect(result.ok).toBe(true);
    // Deduplicated lookup: one query for the one distinct ref.
    expect(store.ingestDeps.findOwnUsageRefs).toHaveBeenCalledWith([USAGE_ID], AGENT_DID);
  });

  it('rejects a usageRef that does not resolve for this agent', async () => {
    const store = createMemoryStore({ usageIds: [] });
    const result = await ingestTurnEvidence(batchOf([signedItem(0, { usageRef: 'att_unknown' })]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'evidence_usage_ref_unresolved' });
    expect(store.rows).toHaveLength(0);
  });

  it('does not look up usage when no item carries a usageRef', async () => {
    const store = createMemoryStore();
    await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);
    expect(store.ingestDeps.findOwnUsageRefs).not.toHaveBeenCalled();
  });
});

describe('ingestTurnEvidence — retain by exception (outputRef)', () => {
  const rawOutput = 'eth_getCode result: 0x6080604052…';
  const outputHash = hashToolIo(rawOutput);
  const hex = outputHash.slice('sha256:'.length);
  const retained = (overrides = {}) => ({
    asset_ok: { ownerDid: PRINCIPAL_DID, hash: hex, ...overrides },
  });

  it('accepts outputRef for an allowlisted tool when the asset is principal-owned and matches outputHash', async () => {
    const store = createMemoryStore({ assets: retained() });
    const item = signedItem(0, { tool: { name: 'web_fetch', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });
    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);
    expect(result.ok).toBe(true);
    expect(store.rows[0].payload.outputRef).toBe('asset_ok');
  });

  it('matches the asset hash case-insensitively', async () => {
    const store = createMemoryStore({ assets: retained({ hash: hex.toUpperCase() }) });
    const item = signedItem(0, { tool: { name: 'web_fetch', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });
    expect((await ingestTurnEvidence(batchOf([item]), store.ingestDeps)).ok).toBe(true);
  });

  it('rejects outputRef for a tool that is not on the evidentiary allowlist', async () => {
    const store = createMemoryStore({ assets: retained() });
    const item = signedItem(0, { tool: { name: 'send_email', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });
    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'evidence_tool_not_evidentiary' });
    expect(store.rows).toHaveLength(0);
  });

  it('rejects when retention is disabled (empty allowlist)', async () => {
    const store = createMemoryStore({ assets: retained(), evidentiaryTools: [] });
    const item = signedItem(0, { tool: { name: 'web_fetch', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });
    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, code: 'evidence_tool_not_evidentiary' });
  });

  it('rejects an asset owned by someone other than the principal — same answer as a missing asset', async () => {
    const owned = createMemoryStore({ assets: retained({ ownerDid: 'did:imajin:stranger' }) });
    const missing = createMemoryStore({ assets: {} });
    const item = signedItem(0, { tool: { name: 'web_fetch', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });

    const first = await ingestTurnEvidence(batchOf([item]), owned.ingestDeps);
    const second = await ingestTurnEvidence(batchOf([item]), missing.ingestDeps);

    expect(first).toMatchObject({ ok: false, status: 422, code: 'evidence_output_ref_invalid' });
    expect(second).toEqual(first);
  });

  it('rejects an asset whose content hash does not equal the signed outputHash', async () => {
    const store = createMemoryStore({ assets: retained({ hash: 'f'.repeat(64) }) });
    const item = signedItem(0, { tool: { name: 'web_fetch', provider: 'openclaw' }, outputHash, outputRef: 'asset_ok' });
    const result = await ingestTurnEvidence(batchOf([item]), store.ingestDeps);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'evidence_output_ref_mismatch' });
  });

  it('never queries assets when nothing asks for retention', async () => {
    const store = createMemoryStore();
    await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);
    expect(store.ingestDeps.findAssets).not.toHaveBeenCalled();
  });
});

describe('ingestTurnEvidence — idempotent replay', () => {
  it('replaying the same batch inserts nothing and reports the duplicate seqs', async () => {
    const store = createMemoryStore();
    const batch = batchOf([signedItem(0), signedItem(1)]);

    await ingestTurnEvidence(batch, store.ingestDeps);
    const replay = await ingestTurnEvidence(batch, store.ingestDeps);

    expect(replay).toEqual({ ok: true, turnEventId: TURN_EVENT_ID, inserted: [], duplicateSeqs: [0, 1] });
    expect(store.rows).toHaveLength(2);
    expect(store.announce).toHaveBeenCalledTimes(2); // no re-announce on replay
  });

  it('stores only the new rows when a retry extends a partial batch', async () => {
    const store = createMemoryStore();
    await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);

    const result = await ingestTurnEvidence(batchOf([signedItem(0), signedItem(1)]), store.ingestDeps);

    expect(result).toMatchObject({ ok: true, duplicateSeqs: [0] });
    expect(result.ok && result.inserted.map((row) => row.seq)).toEqual([1]);
    expect(store.rows).toHaveLength(2);
  });
});
