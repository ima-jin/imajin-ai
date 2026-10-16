import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
const { fakeSql } = vi.hoisted(() => ({ fakeSql: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
import { getLoopOutputArtifact, putLoopOutputArtifact } from '../artifact-store';
import { prepareLoopOutput, MAX_INLINE_LOOP_OUTPUT_BYTES } from '../prepare-output';

beforeEach(() => {
  fakeSql.mockReset().mockResolvedValue([]);
});

describe('scoped loop output artifacts', () => {
  it('content-addresses bytes and scopes identity to principal and loop', async () => {
    const output = { kind: 'text' as const, text: '界' };
    const first = await putLoopOutputArtifact('loop', 'did:owner', output);
    expect(first).toEqual({
      id: expect.stringMatching(/^loa_[0-9a-f]{64}$/),
      sha256: createHash('sha256').update(canonicalize(output)).digest('hex'),
      byteLength: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      mediaType: 'application/json',
    });
    expect(await putLoopOutputArtifact('loop', 'did:owner', output)).toEqual(first);
    expect((await putLoopOutputArtifact('other', 'did:owner', output)).id).not.toBe(first.id);
    expect((await putLoopOutputArtifact('loop', 'did:other', output)).id).not.toBe(first.id);
    const [strings, ...values] = fakeSql.mock.calls[0];
    expect(strings.join(' ? ')).toContain('ON CONFLICT (id) DO NOTHING');
    expect(values).toContain(canonicalize(output));
  });

  it('returns an artifact only through principal AND loop filtering', async () => {
    const output = { kind: 'decision', decision: 'keep' };
    fakeSql.mockResolvedValueOnce([{ id: 'id', sha256: 'hash', byte_length: 42, media_type: 'application/json', content: output }]);
    expect(await getLoopOutputArtifact('loop', 'did:owner', 'id')).toEqual({
      id: 'id', sha256: 'hash', byteLength: 42, mediaType: 'application/json', output,
    });
    const [strings, ...values] = fakeSql.mock.calls[0];
    expect(strings.join('?').replaceAll(/\s+/g, ' ')).toContain('WHERE id = ? AND loop_id = ? AND principal = ?');
    expect(values).toEqual(['id', 'loop', 'did:owner']);
    expect(await getLoopOutputArtifact('other', 'did:owner', 'id')).toBeNull();
    expect(await getLoopOutputArtifact('loop', 'did:other', 'id')).toBeNull();
  });

  it('keeps exactly 16KiB JSON inline and spills the next UTF8 byte', async () => {
    const payload = { loopId: 'loop', principal: 'did:owner', kind: 'test', state: 'running', summary: 'summary', at: new Date().toISOString() };
    const overhead = Buffer.byteLength(JSON.stringify({ kind: 'text', text: '' }), 'utf8');
    const output = { kind: 'text' as const, text: 'x'.repeat(MAX_INLINE_LOOP_OUTPUT_BYTES - overhead) };
    expect((await prepareLoopOutput({ ...payload, output })).output).toEqual(output);
    expect(fakeSql).not.toHaveBeenCalled();
    const spilled = await prepareLoopOutput({ ...payload, output: { ...output, text: `${output.text}😀` } });
    expect(spilled.output).toMatchObject({ kind: 'text', truncated: true, artifactRef: { byteLength: MAX_INLINE_LOOP_OUTPUT_BYTES + 4 } });
    expect(fakeSql).toHaveBeenCalledOnce();
  });
});
