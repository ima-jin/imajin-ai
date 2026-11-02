import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inferenceError, inferenceStream, inferenceText } from '../org-inference-safety';
import type { ResolvedBrain } from '../brain';

const personal: ResolvedBrain = {
  connector: 'anthropic', provider: 'anthropic', credentialDid: 'did:imajin:member',
  modelId: 'claude-test', apiKey: randomUUID(),
};
const org: ResolvedBrain = {
  ...personal, orgUsage: { memberDid: personal.credentialDid, orgDid: 'did:imajin:org', grantId: 'grant', connectionId: 'connection' },
};
function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}
describe('org inference non-disclosure', () => {
  it('does not alter personal responses, streams or error diagnostics', () => {
    expect(inferenceText(personal, personal.apiKey)).toBe(personal.apiKey);
    const source = stream(['hello']);
    expect(inferenceStream(personal, source)).toBe(source);
    expect(inferenceError(personal, new Error('test'))).toBe('test');
    expect(inferenceError(personal, 'test')).toBe('test');
  });
  it('redacts all occurrences and drops untrusted error details for org calls', () => {
    expect(inferenceText(org, `${org.apiKey}:${org.apiKey}`)).toBe('[redacted]:[redacted]');
    expect(inferenceError(org, new Error(org.apiKey))).not.toContain(org.apiKey);
  });
  it('handles empty credentials defensively without transforming every character', () => {
    const brain = { ...org, apiKey: '' };
    const source = stream(['hello']);
    expect(inferenceStream(brain, source)).toBe(source);
    expect(inferenceText(brain, 'hello')).toBe('hello');
  });
  it('redacts a credential echo at every possible chunk boundary, preserving Unicode and SSE bytes otherwise', async () => {
    for (let index = 0; index <= org.apiKey.length; index++) {
      const source = stream(['data: {"text":"é', org.apiKey.slice(0, index), org.apiKey.slice(index), '"}\n\n']);
      const text = await new Response(inferenceStream(org, source)).text();
      expect(text).toBe('data: {"text":"é[redacted]"}\n\n');
    }
  });
  it('preserves chunked non-secret text including a short final suffix', async () => {
    const source = stream(['plain '.repeat(20), 'text', '!']);
    expect(await new Response(inferenceStream(org, source)).text()).toBe(`${'plain '.repeat(20)}text!`);
  });
});
