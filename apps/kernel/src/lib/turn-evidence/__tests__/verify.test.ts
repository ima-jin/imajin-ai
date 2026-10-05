import { describe, it, expect } from 'vitest';
import { buildTurnEvidencePayload, hashToolIo, normalizeHash } from '@imajin/auth';
import { ingestTurnEvidence } from '../ingest';
import { verifyTurnByHash, type TurnEventRef } from '../verify';
import { createMemoryStore, type MemoryStoreOptions } from './memory-store';
import {
  AGENT_DID,
  AGENT_KEYPAIR,
  CLAIM_HASH,
  CLAIM_TEXT,
  OTHER_KEYPAIR,
  PRINCIPAL_DID,
  TURN_EVENT_ID,
  USAGE_ID,
  batchOf,
  evidenceFields,
  signItem,
  signedItem,
} from './helpers';

async function storeWithTurn(options: MemoryStoreOptions = {}, count = 3) {
  const store = createMemoryStore(options);
  const items = Array.from({ length: count }, (_, seq) => signedItem(seq));
  const ingested = await ingestTurnEvidence(batchOf(items), store.ingestDeps);
  expect(ingested.ok).toBe(true);
  return store;
}

function turnEvent(overrides: Partial<TurnEventRef> = {}): TurnEventRef {
  return {
    id: TURN_EVENT_ID,
    eventType: 'agent.turn',
    issuer: AGENT_DID,
    occurredAt: new Date('2026-09-04T03:54:20Z'),
    outputHash: CLAIM_HASH,
    usageRef: null,
    ...overrides,
  };
}

describe('verifyTurnByHash — valid hash', () => {
  it('returns the signed evidence chain for the claim, ordered by seq', async () => {
    const store = await storeWithTurn();

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.hash).toBe(CLAIM_HASH);
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match.turnEventId).toBe(TURN_EVENT_ID);
    expect(match.agentDid).toBe(AGENT_DID);
    expect(match.signer).toEqual({ did: AGENT_DID, keyId: AGENT_KEYPAIR.publicKey });
    expect(match.signatureValid).toBe(true);
    expect(match.valid).toBe(true);
    expect(match.rejectedRows).toBe(0);
    expect(match.evidence.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(match.evidence.map((row) => row.tool.name)).toEqual(['web_fetch', 'eth_getCode', 'web_fetch']);
    for (const row of match.evidence) {
      expect(row.signatureValid).toBe(true);
      expect(row.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.observedAt).toBe('2026-09-04T03:54:12Z');
      expect(Number.isNaN(Date.parse(row.issuedAt))).toBe(false);
      expect(row.retained).toBe(false);
    }
  });

  it('accepts the bare-hex and uppercase forms of the same hash', async () => {
    const store = await storeWithTurn();
    const bare = CLAIM_HASH.slice('sha256:'.length);
    expect((await verifyTurnByHash(bare, store.verifyDeps)).found).toBe(true);
    expect((await verifyTurnByHash(bare.toUpperCase(), store.verifyDeps)).found).toBe(true);
  });

  it('reports retention without disclosing the asset reference, principal, or usage ref', async () => {
    const rawOutput = 'retained output';
    const outputHash = hashToolIo(rawOutput);
    const store = createMemoryStore({
      usageIds: [USAGE_ID],
      assets: { asset_secretish123: { ownerDid: PRINCIPAL_DID, hash: outputHash.slice('sha256:'.length) } },
    });
    await ingestTurnEvidence(
      batchOf([
        signedItem(0, {
          tool: { name: 'web_fetch', provider: 'openclaw' },
          outputHash,
          outputRef: 'asset_secretish123',
          usageRef: USAGE_ID,
        }),
      ]),
      store.ingestDeps,
    );

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found && result.matches[0].evidence[0].retained).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('asset_secretish123');
    expect(serialized).not.toContain(PRINCIPAL_DID);
    expect(serialized).not.toContain(USAGE_ID);
    expect(serialized).not.toContain('outputRef');
    expect(serialized).not.toContain('principalDid');
  });
});

describe('verifyTurnByHash — unknown hash', () => {
  it('is not found for a hash nothing is committed under', async () => {
    const store = await storeWithTurn();
    expect(await verifyTurnByHash(hashToolIo('a claim nobody made'), store.verifyDeps)).toEqual({ found: false });
  });

  it('is not found when one byte of the claimed output is altered', async () => {
    const store = await storeWithTurn();
    const altered = hashToolIo(CLAIM_TEXT.replace('live', 'dead'));
    expect(altered).not.toBe(CLAIM_HASH);
    expect(await verifyTurnByHash(altered, store.verifyDeps)).toEqual({ found: false });
    const lastByteChanged = hashToolIo(`${CLAIM_TEXT.slice(0, -1)},`);
    expect(await verifyTurnByHash(lastByteChanged, store.verifyDeps)).toEqual({ found: false });
  });

  it('is not found for a malformed hash, without touching storage', async () => {
    const store = await storeWithTurn();
    for (const bad of ['', 'sha256:xyz', 'not-a-hash', `sha256:${'0'.repeat(63)}`]) {
      expect(await verifyTurnByHash(bad, store.verifyDeps)).toEqual({ found: false });
    }
    expect(store.verifyDeps.findEvidenceByTurnOutputHash).not.toHaveBeenCalled();
  });
});

describe('verifyTurnByHash — tampered records', () => {
  it('flags a row whose stored payload was altered after signing', async () => {
    const store = await storeWithTurn();
    (store.rows[1].payload as { outputHash: string }).outputHash = hashToolIo('forged output');

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    const [match] = result.matches;
    expect(match.signatureValid).toBe(false);
    expect(match.valid).toBe(false);
    expect(match.evidence.map((row) => row.signatureValid)).toEqual([true, false, true]);
  });

  it('flags a row whose stored signature was swapped for another key’s', async () => {
    const store = await storeWithTurn();
    const forged = signedItem(1);
    // re-sign the same payload with a different key and store that instead
    store.rows[1].signature = signItem(forged.payload, OTHER_KEYPAIR.privateKey, forged.issuedAt).signature;

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found && result.matches[0].evidence[1].signatureValid).toBe(false);
    expect(result.found && result.matches[0].valid).toBe(false);
  });

  it('flags a row whose issued_at was altered (it is part of the signed form)', async () => {
    const store = await storeWithTurn();
    store.rows[0].issuedAt = new Date(store.rows[0].issuedAt.getTime() + 1);

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found && result.matches[0].evidence[0].signatureValid).toBe(false);
  });

  it('flags a row whose context (turn event id) was moved to another turn', async () => {
    const store = await storeWithTurn();
    store.rows[2].contextId = 'turn_evt_other';

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    // The relocated row now sits in its own group and is rejected (payload.turnEventId disagrees with context).
    const rejected = result.matches.find((match) => match.turnEventId === 'turn_evt_other');
    expect(rejected?.rejectedRows).toBe(1);
    expect(rejected?.valid).toBe(false);
  });

  it('never silently drops a row that no longer parses as evidence', async () => {
    const store = await storeWithTurn();
    (store.rows[0].payload as unknown as Record<string, unknown>).rawOutput = 'smuggled content';

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.matches[0].rejectedRows).toBe(1);
    expect(result.matches[0].evidence).toHaveLength(2);
    expect(result.matches[0].valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('smuggled content');
  });

  it('is invalid with a null keyId when the signer no longer resolves to a key', async () => {
    const store = await storeWithTurn();
    const noKeys = { ...store.verifyDeps, resolveIssuerKey: async () => null };

    const result = await verifyTurnByHash(CLAIM_HASH, noKeys);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.matches[0].signer.keyId).toBeNull();
    expect(result.matches[0].signatureValid).toBe(false);
    expect(result.matches[0].valid).toBe(false);
  });

  it('is invalid when the signer has rotated to a different key', async () => {
    const store = await storeWithTurn();
    const rotated = { ...store.verifyDeps, resolveIssuerKey: async () => OTHER_KEYPAIR.publicKey };

    const result = await verifyTurnByHash(CLAIM_HASH, rotated);

    expect(result.found && result.matches[0].signatureValid).toBe(false);
  });
});

describe('verifyTurnByHash — linkage integrity (evidence → turn → usage)', () => {
  it('resolves evidence → turn event → usage when all three agree', async () => {
    const store = await storeWithTurn({
      usageIds: [USAGE_ID],
      turnEvents: { [TURN_EVENT_ID]: turnEvent({ usageRef: USAGE_ID }) },
    });

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    const [match] = result.matches;
    expect(match.linkage).toEqual({ turn: 'resolved', usage: 'resolved' });
    expect(match.turn).toEqual({
      id: TURN_EVENT_ID,
      eventType: 'agent.turn',
      issuer: AGENT_DID,
      occurredAt: '2026-09-04T03:54:20.000Z',
    });
    expect(match.valid).toBe(true);
    expect(store.verifyDeps.usageExists).toHaveBeenCalledWith(USAGE_ID, AGENT_DID);
  });

  it('reports a turn event that names a different claim as a mismatch, and invalid', async () => {
    const store = await storeWithTurn({
      turnEvents: { [TURN_EVENT_ID]: turnEvent({ outputHash: hashToolIo('a different claim') }) },
    });

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.matches[0].linkage.turn).toBe('mismatch');
    expect(result.matches[0].signatureValid).toBe(true);
    expect(result.matches[0].valid).toBe(false);
  });

  it('is unresolved (never fabricated) when the turn event does not exist yet', async () => {
    const store = await storeWithTurn();
    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);
    expect(result.found && result.matches[0].turn).toBeNull();
    expect(result.found && result.matches[0].linkage).toEqual({ turn: 'unresolved', usage: 'none' });
    expect(result.found && result.matches[0].valid).toBe(true);
  });

  it('is unresolved when the turn event carries no outputHash to compare', async () => {
    const store = await storeWithTurn({ turnEvents: { [TURN_EVENT_ID]: turnEvent({ outputHash: null }) } });
    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);
    expect(result.found && result.matches[0].linkage.turn).toBe('unresolved');
    expect(result.found && result.matches[0].turn?.id).toBe(TURN_EVENT_ID);
  });

  it('treats a bare-hex turn outputHash as the same claim', async () => {
    const store = await storeWithTurn({
      turnEvents: { [TURN_EVENT_ID]: turnEvent({ outputHash: normalizeHash(CLAIM_HASH)?.slice('sha256:'.length) ?? null }) },
    });
    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);
    expect(result.found && result.matches[0].linkage.turn).toBe('resolved');
  });

  it('falls back to the usageRef signed into the evidence when the turn event has none', async () => {
    const store = createMemoryStore({ usageIds: [USAGE_ID] });
    await ingestTurnEvidence(batchOf([signedItem(0, { usageRef: USAGE_ID })]), store.ingestDeps);

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found && result.matches[0].linkage.usage).toBe('resolved');
  });

  it('reports a usage attestation that has since expired as unresolved without invalidating the evidence', async () => {
    const store = createMemoryStore({ usageIds: [USAGE_ID] });
    await ingestTurnEvidence(batchOf([signedItem(0, { usageRef: USAGE_ID })]), store.ingestDeps);
    const afterExpiry = { ...store.verifyDeps, usageExists: async () => false };

    const result = await verifyTurnByHash(CLAIM_HASH, afterExpiry);

    expect(result.found && result.matches[0].linkage.usage).toBe('unresolved');
    expect(result.found && result.matches[0].valid).toBe(true);
  });
});

describe('verifyTurnByHash — several turns under one hash', () => {
  it('returns one match per (turn, signer), sorted, and resolves each signer’s key once', async () => {
    const store = createMemoryStore();
    await ingestTurnEvidence(batchOf([signedItem(0, { turnEventId: 'turn_evt_b' })]), store.ingestDeps);
    await ingestTurnEvidence(
      batchOf([signedItem(0, { turnEventId: 'turn_evt_a' }), signedItem(1, { turnEventId: 'turn_evt_a' })]),
      store.ingestDeps,
    );

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.matches.map((match) => [match.turnEventId, match.evidence.length])).toEqual([
      ['turn_evt_a', 2],
      ['turn_evt_b', 1],
    ]);
    expect(store.verifyDeps.resolveIssuerKey).toHaveBeenCalledTimes(1);
  });

  it('keeps different signers’ evidence for the same turn in separate matches', async () => {
    const otherDid = 'did:imajin:other-agent';
    const store = createMemoryStore({ keys: { [AGENT_DID]: AGENT_KEYPAIR.publicKey, [otherDid]: OTHER_KEYPAIR.publicKey } });
    await ingestTurnEvidence(batchOf([signedItem(0)]), store.ingestDeps);
    const foreign = signItem(
      buildTurnEvidencePayload(evidenceFields(0, { agentDid: otherDid, principalDid: otherDid })),
      OTHER_KEYPAIR.privateKey,
    );
    await ingestTurnEvidence(batchOf([foreign]), store.ingestDeps);

    const result = await verifyTurnByHash(CLAIM_HASH, store.verifyDeps);

    expect(result.found && result.matches.map((match) => match.agentDid).sort((a, b) => a.localeCompare(b))).toEqual([
      AGENT_DID,
      otherDid,
    ]);
    expect(result.found && result.matches.every((match) => match.valid)).toBe(true);
  });
});
