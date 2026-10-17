// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoopOutput } from '@imajin/bus';
import { RunOutput } from '../run-output';

afterEach(cleanup);

describe('Registry typed output', () => {
  it.each([
    [{ kind: 'text', text: '<script>unsafe()</script>', role: 'assistant' }, '<script>unsafe()</script>'],
    [{ kind: 'tool_call', callId: 'call', name: 'inspect', args: { file: 'a.ts' } }, 'Tool call · inspect'],
    [{ kind: 'tool_result', callId: 'call', result: [1, true] }, 'Tool result'],
    [{ kind: 'tool_result', callId: 'call', result: null, isError: true }, 'Tool error'],
    [{ kind: 'artifact', ref: 'javascript:alert(1)' }, 'unknown type'],
    [{ kind: 'artifact', ref: 'artifact:1', name: 'report', mediaType: 'text/plain' }, 'report'],
    [{ kind: 'decision', decision: 'continue', reason: 'verified' }, 'continue verified'],
    [{ kind: 'approval_request', approvalId: 'approval-1', action: 'write', details: { path: 'a.ts' } }, 'Approval requested'],
    [{ kind: 'spawn', loopId: 'child', principal: 'did:principal' }, 'Spawned loop · child'],
    [{ kind: 'model_change', model: 'new', previousModel: 'old', provider: 'fixture' }, 'old → new'],
    [{ kind: 'model_change', model: 'first' }, 'Model · first'],
  ])('renders %j as non-executable text', (output, expected) => {
    const { container } = render(<RunOutput output={output as LoopOutput} />);
    expect(container.textContent).toContain(expected);
    expect(container.querySelector('script,a,iframe,img')).toBeNull();
  });

  it('shows stored artifact metadata and preview without fetching or inventing a link', () => {
    const { container } = render(<RunOutput output={{
      kind: 'tool_result', truncated: true, preview: 'redacted preview',
      artifactRef: { id: 'artifact-1', byteLength: 20000, mediaType: 'application/json', sha256: 'a'.repeat(64) },
    }} />);
    expect(container.textContent).toContain('truncated preview');
    expect(container.textContent).toContain('20000 bytes');
    expect(container.textContent).toContain('artifact-1');
    expect(container.querySelector('a')).toBeNull();
  });
});
