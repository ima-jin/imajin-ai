'use client';

import type { LoopOutput, StoredLoopOutput } from '@imajin/bus';

function Value({ value }: Readonly<{ value: unknown }>) {
  return <pre className="min-w-0 whitespace-pre-wrap break-words text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

/** Registry output only: never resolve a transcript, tool call, or publisher-controlled URL. */
export function RunOutput({ output }: Readonly<{ output: LoopOutput | StoredLoopOutput }>) {
  if ('artifactRef' in output) {
    return <div className="min-w-0 break-words" data-testid="stored-output">
      <p>Stored {output.kind} · {output.artifactRef.byteLength} bytes · truncated preview</p>
      <pre className="whitespace-pre-wrap break-words">{output.preview}</pre>
      <p className="break-all">Artifact {output.artifactRef.id} · SHA-256 {output.artifactRef.sha256}</p>
    </div>;
  }
  switch (output.kind) {
    case 'text': return <p className="whitespace-pre-wrap break-words">{output.text}</p>;
    case 'tool_call': return <div><p>Tool call · {output.name} · {output.callId}</p><Value value={output.args} /></div>;
    case 'tool_result': return <div><p>{output.isError ? 'Tool error' : 'Tool result'} · {output.callId}</p><Value value={output.result} /></div>;
    case 'artifact': return <p className="break-all">Artifact · {output.name ?? output.ref} · {output.mediaType ?? 'unknown type'}<br />{output.ref}</p>;
    case 'decision': return <p>Decision · {output.decision} {output.reason}</p>;
    case 'approval_request': return <div><p>Approval requested · {output.action} · {output.approvalId}</p><Value value={output.details} /></div>;
    case 'spawn': return <p className="break-all">Spawned loop · {output.loopId} {output.principal}</p>;
    case 'model_change': return <p>Model · {output.previousModel ? `${output.previousModel} → ` : ''}{output.model} {output.provider}</p>;
  }
}
