import type { LoopOutput } from '@imajin/bus';

export const OUTPUTS: LoopOutput[] = [
  { kind: 'text', text: 'hello', role: 'assistant' },
  { kind: 'tool_call', callId: 'call1', name: 'shell', args: { unknown: [null, 42, true, { extra: 'keep me' }] } },
  { kind: 'tool_result', callId: 'call1', result: { unknown: [false, { more: 2 }] }, isError: false },
  { kind: 'artifact', ref: 'file://report', name: 'report', mediaType: 'text/plain' },
  { kind: 'decision', decision: 'ship', reason: 'tests pass' },
  { kind: 'approval_request', approvalId: 'a1', action: 'release', details: { unknown: [1, null] } },
  { kind: 'spawn', loopId: 'child', principal: 'did:imajin:user' },
  { kind: 'model_change', model: 'next', previousModel: 'old', provider: 'local' },
];
