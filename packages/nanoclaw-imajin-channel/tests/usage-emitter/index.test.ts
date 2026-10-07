import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/usage-emitter/index.js';

function assistantLine(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-02T12:00:00.000Z',
    message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } },
    ...extra,
  });
}

describe('usage-emitter main', () => {
  let dir: string;
  const envKeys = ['KERNEL_URL', 'USAGE_EMIT_TOKEN', 'NANOCLAW_PROJECTS_DIR', 'USAGE_EMITTER_STATE_FILE'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanoclaw-usage-main-'));
    process.env.KERNEL_URL = 'https://kernel.test';
    process.env.USAGE_EMIT_TOKEN = 'token';
    process.env.NANOCLAW_PROJECTS_DIR = join(dir, 'projects');
    process.env.USAGE_EMITTER_STATE_FILE = join(dir, 'state.json');
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    envKeys.forEach((key) => delete process.env[key]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('stamps every posted row with the session id from its JSONL file', async () => {
    writeFileSync(join(dir, 'projects', 'p', 'sess-a.jsonl'), `${assistantLine('m1')}\n`);
    writeFileSync(join(dir, 'projects', 'p', 'sess-b.jsonl'), `${assistantLine('m2')}\n${assistantLine('m3', { sessionId: 'line-sess' })}\n`);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ inserted: 3, skipped: 0, rejected: [] }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await main();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const posted = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Array<{ external_id: string; session_id: string }>;
    const sessions = Object.fromEntries(posted.map((row) => [row.external_id, row.session_id]));
    expect(sessions).toEqual({ m1: 'sess-a', m2: 'sess-b', m3: 'line-sess' });
  });

  it('posts nothing when there are no new rows', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when required env is missing', async () => {
    delete process.env.KERNEL_URL;

    await main();

    expect(process.exitCode).toBe(1);
  });
});
