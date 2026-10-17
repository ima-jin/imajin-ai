// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunsPreviewTransport, installRunsPreview } from '../transport';
import { dispatchSessionCommand, prepareSignedSessionCommand } from '@/app/jin/session-command-client';
import type { SessionCommandType } from '@/src/lib/jin/session-command-contract';
import * as ed from '@noble/ed25519';
import { canonicalCommandJson } from '@/app/jin/session-command-client';

beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('development-only Runs transport', () => {
  it('refuses production initialization', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createRunsPreviewTransport()).rejects.toThrow('Development fixture only');
  });

  it('provides exact signed native binding evidence and uses one existing decision rail for approve/deny', async () => {
    const fixture = await createRunsPreviewTransport();
    vi.stubGlobal('fetch', fixture.fetcher);
    for (const proof of fixture.bindingProofs) {
      const { signature, ...body } = proof.attestation;
      expect(proof.type).toBe('loop.approval.bound');
      expect(Object.keys(body.payload!).sort()).toEqual(['agentDid', 'approvalId', 'loopId', 'principalDid']);
      expect(await ed.verifyAsync(ed.etc.hexToBytes(signature), new TextEncoder().encode(canonicalCommandJson(body)), ed.etc.hexToBytes(fixture.agentPublicKey))).toBe(true);
    }
    const post = (id: string, body: unknown) => fixture.fetcher(`/jin/api/operator-approvals/${id}/decision`, { body: JSON.stringify(body) });
    expect((await post('missing', {})).status).toBe(404);
    expect((await post('fixture-allow', {})).status).toBe(400);
    for (const choice of ['approve', 'reject'] as const) {
      const id = choice === 'approve' ? 'fixture-allow' : 'fixture-deny';
      const approvalId = choice === 'approve' ? 'native-allow' : 'native-deny';
      const type = choice === 'approve' ? 'session.approve' : 'session.deny';
      const command = await prepareSignedSessionCommand('fixture-session', type, { loopId: 'fixture-session', approvalId, kind: 'exec' }, fixture.keypair);
      await expect(dispatchSessionCommand('fixture-session', command)).rejects.toThrow('Authorization changed');
      expect((await post(id, { decision: choice, sessionCommand: command })).status).toBe(200);
      expect((await post(id, { decision: choice, sessionCommand: command })).status).toBe(409);
    }
    const before = await (await fixture.fetcher('/jin/api/operator-approvals')).json();
    expect(before.approvals.map((card: { status: string }) => card.status)).toEqual(['approved', 'denied']);
    expect(before.approvals.every((card: { sessionOutcome?: unknown }) => !card.sessionOutcome)).toBe(true);
    await vi.waitFor(() => expect(fixture.proofs).toHaveLength(2), { timeout: 2000 });
    const after = await (await fixture.fetcher('/jin/api/operator-approvals')).json();
    expect(after.approvals.every((card: { sessionOutcome: { outcome: string } }) => card.sessionOutcome.outcome === 'completed')).toBe(true);
    for (const proof of fixture.proofs) {
      const envelope = proof.attestation as { payload: Record<string, unknown> };
      expect(envelope.payload.approvalKind).toBe('exec');
      expect(envelope.payload.approvalId).toMatch(/^native-/);
    }
  });

  it('uses exact signed #77 thread outcomes and establishes child lineage', async () => {
    const fixture = await createRunsPreviewTransport();
    vi.stubGlobal('fetch', fixture.fetcher);
    const cases: [SessionCommandType, Record<string, string>][] = [
      ['session.send', { loopId: 'fixture-session', message: 'continue' }],
      ['session.abort', { loopId: 'fixture-session' }],
      ['session.spawn', { parentLoopId: 'fixture-session', task: 'child task', label: 'child', group: 'group', model: 'model' }],
    ];
    for (const [type, payload] of cases) {
      const command = await prepareSignedSessionCommand('fixture-session', type, payload, fixture.keypair);
      expect(await dispatchSessionCommand('fixture-session', command)).toEqual({ commandId: command.commandId, delivered: true });
      await expect(dispatchSessionCommand('fixture-session', command)).rejects.toThrow('No execution confirmed');
    }
    await vi.waitFor(() => expect(fixture.proofs).toHaveLength(3), { timeout: 2000 });
    for (const proof of fixture.proofs) {
      expect(Object.keys(proof)).toEqual(['type', 'attestation']);
      const envelope = proof.attestation as { from: string; type: string; timestamp: number; signature: string; payload: Record<string, unknown> };
      expect(envelope.from).toBe(envelope.payload.agentDid);
      expect(envelope.type).toBe('agent');
      expect(envelope.signature).toMatch(/^[a-f0-9]{128}$/);
      expect(envelope.payload.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(envelope.payload.outcome).toBe('completed');
      expect(envelope.payload).not.toHaveProperty('message');
      expect(envelope.payload).not.toHaveProperty('task');
    }
    const page = await (await fixture.fetcher('/jin/api/runs')).json();
    const child = page.page.loops.find((loop: { parentLoopId: string }) => loop.parentLoopId === 'fixture-session');
    expect(child.kind).toBe('openclaw.subagent');
    const spawn = fixture.proofs.find((proof) => proof.type === 'loop.session.spawn.completed')!;
    const payload = (spawn.attestation as { payload: Record<string, unknown> }).payload;
    expect(payload.childLoopId).toBe(payload.loopId);
    expect(payload.parentLoopId).toBe('fixture-session');
    const detail = await (await fixture.fetcher('/jin/api/runs/fixture-session')).json();
    expect(detail.detail.events.filter((event: { type: string }) => event.type.startsWith('loop.session.'))).toHaveLength(3);
    expect(detail.detail.events.filter((event: { payload: { output?: unknown } }) => event.payload.output)).toHaveLength(9);
    expect(detail.commandTarget.available).toBe(true);
  });

  it('rejects unprepared, unsigned, and modified commands without execution', async () => {
    const fixture = await createRunsPreviewTransport();
    vi.stubGlobal('fetch', fixture.fetcher);
    const command = await prepareSignedSessionCommand('fixture-session', 'session.abort', { loopId: 'fixture-session' }, fixture.keypair);
    const post = (frame: unknown) => fixture.fetcher('/jin/api/runs/fixture-session/commands', { body: JSON.stringify({ action: 'dispatch', command: frame }) });
    expect((await post({ ...command, commandId: 'unknown' })).status).toBe(409);
    expect((await post({ ...command, countersignature: undefined })).status).toBe(409);
    expect((await post({ ...command, to: 'did:other' })).status).toBe(403);
    expect(fixture.proofs).toEqual([]);
  });

  it('serves scoped reads, both surface participants and refuses every unknown transport', async () => {
    const fixture = await createRunsPreviewTransport();
    expect((await fixture.fetcher('/warp/api/runs')).status).toBe(404);
    expect((await fixture.fetcher('/jin/api/runs/unknown')).status).toBe(404);
    const warp = await (await fixture.fetcher('/jin/api/runs/fixture-warp')).json();
    expect(warp.commandTarget.available).toBe(false);
    const surfaces = await (await fixture.fetcher('/api/loops/surfaces')).json();
    expect(surfaces.warnOnly).toBe(true);
    expect(surfaces.conflicts[0].payload.refs.conflictingLoopId).toBe('fixture-warp');
    const cards = await (await fixture.fetcher('/jin/api/operator-approvals')).json();
    expect(cards.isOperator).toBe(true);
    expect(cards.approvals).toHaveLength(2);
  });

  it('installs only transport and an in-memory signer without touching saved keys; cleanup restores fetch', async () => {
    const original = globalThis.fetch;
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const preview = await installRunsPreview();
    expect(storage).not.toHaveBeenCalled();
    const command = await preview.client.prepare('fixture-session', 'session.abort', { loopId: 'fixture-session' });
    expect((await preview.client.dispatch('fixture-session', command)).delivered).toBe(true);
    preview.dispose();
    expect(globalThis.fetch).toBe(original);
    storage.mockRestore();
  });
});
