import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopOutput } from '@imajin/bus';

const state = vi.hoisted(() => ({
  principal: 'did:imajin:operator',
  loops: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
  artifacts: new Map<string, Record<string, unknown>>(),
  verify: vi.fn(),
}));

vi.mock('@imajin/auth', async (importOriginal) => ({
  ...await importOriginal<object>(),
  requireAuth: async () => ({ identity: { id: state.principal } }),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/src/lib/loops/verify-publisher-signature', () => ({ verifyLoopPublisherSignature: state.verify }));
vi.mock('@/src/lib/loops/authorize-publisher', () => ({ authorizeLoopPublisher: async () => ({ authorized: true }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/bus', () => ({
  publish: async (type: string, event: { payload: Record<string, unknown>; issuer: string }) => {
    const payload = event.payload;
    state.events.push({
      id: `event_${state.events.length}`, loop_id: payload.loopId, type, issuer: event.issuer,
      principal: payload.principal, payload, occurred_at: payload.at, created_at: payload.at,
    });
  },
}));
vi.mock('@imajin/db', () => ({
  getClient: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('UPDATE kernel.surface_lease')) return [];
    if (query.includes('FROM kernel.surface_lease')) return [];
    if (query.includes('INSERT INTO kernel.loops')) {
      const [loopId, kind, principal] = values as string[];
      const owner = state.loops.get(loopId);
      if (owner && owner.principal !== principal) return [];
      state.loops.set(loopId, {
        loop_id: loopId, kind, principal, refs: {}, state: 'running', summary: 'output',
        parent_loop_id: null, last_event_type: 'loop.progress',
        started_at: new Date(), last_seen_at: new Date(), finished_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      return [{ loop_id: loopId }];
    }
    if (query.includes('INSERT INTO kernel.loop_output_artifacts')) {
      const [id, loopId, principal, sha256, byteLength, content] = values;
      state.artifacts.set(String(id), {
        id, loop_id: loopId, principal, sha256, byte_length: byteLength,
        media_type: 'application/json', content: JSON.parse(String(content)),
      });
      return [];
    }
    if (query.includes('FROM kernel.loop_output_artifacts')) {
      const [id, loopId, principal] = values;
      const artifact = state.artifacts.get(String(id));
      return artifact?.loop_id === loopId && artifact?.principal === principal ? [artifact] : [];
    }
    if (query.includes('FROM kernel.loop_events')) {
      const [loopId, principal] = values;
      return state.events.filter((event) => event.loop_id === loopId && event.principal === principal);
    }
    if (query.includes('FROM kernel.loops')) {
      const [loopId, principal] = values;
      const loop = state.loops.get(String(loopId));
      return loop?.principal === principal ? [loop] : [];
    }
    throw new Error('Unexpected SQL in loop roundtrip');
  },
}));

import { POST } from '../route';
import { GET } from '../[loopId]/route';
import { GET as GET_ARTIFACT } from '../[loopId]/artifacts/[artifactId]/route';

const outputs: LoopOutput[] = [
  { kind: 'text', text: 'hello' },
  { kind: 'tool_call', callId: 'c1', name: 'search', args: { query: 'loops' } },
  { kind: 'tool_result', callId: 'c1', result: { hits: 3 }, isError: false },
  { kind: 'artifact', ref: 'media_1', name: 'report', mediaType: 'text/plain' },
  { kind: 'decision', decision: 'SQL', reason: 'durable' },
  { kind: 'approval_request', approvalId: 'a1', action: 'deploy', details: { env: 'dev' } },
  { kind: 'spawn', loopId: 'child_1' },
  { kind: 'model_change', model: 'new', previousModel: 'old' },
];

function publish(output: LoopOutput, index = 0) {
  return POST(new Request('https://test.imajin.ai/api/loops', {
    method: 'POST',
    body: JSON.stringify({
      type: 'loop.progress',
      payload: {
        loopId: 'roundtrip', kind: 'agent.run', principal: 'did:imajin:operator',
        state: 'running', summary: 'output', at: new Date(Date.now() + index).toISOString(), output,
      },
      publisherDid: 'did:imajin:operator',
      signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) },
    }),
  }) as Parameters<typeof POST>[0]);
}
function read() {
  return GET(new Request('https://test.imajin.ai/api/loops/roundtrip') as Parameters<typeof GET>[0],
    { params: Promise.resolve({ loopId: 'roundtrip' }) });
}

beforeEach(() => {
  state.principal = 'did:imajin:operator';
  state.loops.clear();
  state.events.length = 0;
  state.artifacts.clear();
  state.verify.mockReset().mockResolvedValue({ ok: true });
});

describe('loop output route/ingest/read roundtrip', () => {
  it('publishes all eight output kinds and reads them in history order', async () => {
    for (const [index, output] of outputs.entries()) expect((await publish(output, index)).status).toBe(201);
    const response = await read();
    expect(response.status).toBe(200);
    const history = await response.json();
    expect(history.events.map((event: { payload: { output: unknown } }) => event.payload.output)).toEqual(outputs);
    expect(state.verify).toHaveBeenCalledTimes(8);
    state.principal = 'did:imajin:other';
    expect((await read()).status).toBe(404);
  });

  it('stores only redacted overflow and returns its full output through a private artifact ref', async () => {
    const result = { message: '🙂'.repeat(6000), apiKey: 'private-value' };
    expect((await publish({ kind: 'tool_result', callId: 'c1', result })).status).toBe(201);
    const history = await (await read()).json();
    const output = history.events[0].payload.output;
    expect(output).toMatchObject({ kind: 'tool_result', truncated: true });
    expect(output.preview).not.toContain('private-value');
    const params = { params: Promise.resolve({ loopId: 'roundtrip', artifactId: output.artifactRef.id }) };
    const request = new Request('https://test.imajin.ai/api/loops/roundtrip/artifacts/ref');
    const response = await GET_ARTIFACT(request as Parameters<typeof GET_ARTIFACT>[0], params);
    const artifact = await response.json();
    expect(artifact.output.result.message).toBe(result.message);
    expect(JSON.stringify(artifact)).not.toContain('private-value');
    state.principal = 'did:imajin:other';
    expect((await GET_ARTIFACT(request as Parameters<typeof GET_ARTIFACT>[0], params)).status).toBe(404);
  });

  it('does not reserve, store, or emit a signature-rejected output', async () => {
    state.verify.mockResolvedValue({ ok: false, error: 'Invalid publisher signature' });
    expect((await publish(outputs[0])).status).toBe(400);
    expect(state.events).toHaveLength(0);
    expect(state.loops.size).toBe(0);
    expect(state.artifacts.size).toBe(0);
  });
});
