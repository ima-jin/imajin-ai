// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunsPreviewTransport, installRunsPreview } from '../transport';
import { dispatchSessionCommand, prepareSignedSessionCommand } from '@/app/jin/session-command-client';
import type { SessionCommandType } from '@/src/lib/jin/session-command-contract';

beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('development-only Runs transport', () => {
  it('refuses production initialization', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createRunsPreviewTransport()).rejects.toThrow('Development fixture only');
  });

  it('uses exact signed #77 outcomes for all five verbs and establishes child lineage', async () => {
    const fixture = await createRunsPreviewTransport();
    vi.stubGlobal('fetch', fixture.fetcher);
    const cases: [SessionCommandType, Record<string, string>][] = [
      ['session.send', { loopId: 'fixture-session', message: 'continue' }],
      ['session.abort', { loopId: 'fixture-session' }],
      ['session.spawn', { parentLoopId: 'fixture-session', task: 'child task', label: 'child', group: 'group', model: 'model' }],
      ['session.approve', { approvalId: 'native', loopId: 'fixture-session', kind: 'exec' }],
      ['session.deny', { approvalId: 'native-other', loopId: 'fixture-session', kind: 'plugin' }],
    ];
    for (const [type, payload] of cases) {
      const command = await prepareSignedSessionCommand('fixture-session', type, payload, fixture.keypair);
      expect(await dispatchSessionCommand('fixture-session', command)).toEqual({ commandId: command.commandId, delivered: true });
      await expect(dispatchSessionCommand('fixture-session', command)).rejects.toThrow('No execution confirmed');
    }
    await vi.waitFor(() => expect(fixture.proofs).toHaveLength(5), { timeout: 2000 });
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
    expect(detail.detail.events).toHaveLength(5);
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
    expect(await (await fixture.fetcher('/jin/api/operator-approvals')).json()).toEqual({ isOperator: true, approvals: [] });
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
