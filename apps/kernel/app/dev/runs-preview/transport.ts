import * as ed from '@noble/ed25519';
import type { LoopJson, LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandBody, SessionCommandFrame } from '@/src/lib/jin/session-command-contract';
import type { OperatorApprovalCard } from '@/app/jin/operator-approvals-panel';
import type { LoopOutput, StoredLoopOutput } from '@imajin/bus';
import { canonicalCommandJson, prepareSignedSessionCommand, dispatchSessionCommand, type SessionCommandClient } from '@/app/jin/session-command-client';
import { createHorizonFixture } from './horizon-fixture';

const principal = 'did:imajin:fixture-principal';
const agent = 'did:imajin:fixture-agent';
const issuer = 'did:imajin:fixture-kernel';
const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(canonicalCommandJson(value));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixtureUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input, 'https://fixture.local');
  if (input instanceof URL) return input;
  return new URL(input.url);
}

async function fixtureBody(input: RequestInfo | URL, options?: RequestInit): Promise<Record<string, unknown>> {
  let raw: unknown;
  if (options?.body !== undefined && options.body !== null) {
    if (typeof options.body !== 'string') throw new TypeError('Fixture requests require JSON text');
    raw = JSON.parse(options.body);
  } else if (input instanceof Request) {
    raw = await input.json();
  } else {
    throw new TypeError('Fixture request body is required');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Fixture request body must be a JSON object');
  return raw as Record<string, unknown>;
}

function fixtureLoop(loopId: string, kind: string, parentLoopId: string | null = null): LoopJson {
  const at = new Date().toISOString();
  return { loopId, kind, principal, parentLoopId, refs: { issue: 'ima-jin/imajin-ai#2404' },
    summary: loopId === 'fixture-session' ? 'Review loop-addressed controls' : `Fixture ${loopId}`,
    state: 'running', lastEventType: 'loop.progress', startedAt: at, lastSeenAt: at,
    finishedAt: null, createdAt: at, updatedAt: at };
}

function commandBody(command: SessionCommandBody): SessionCommandBody {
  const { type, commandId, to, principal: owner, issuer: grantIssuer, issuedAt, expiresAt, payload } = command;
  return { type, commandId, to, principal: owner, issuer: grantIssuer, issuedAt, expiresAt, payload };
}

function fixtureOutputs(): (LoopOutput | StoredLoopOutput)[] {
  return [
    { kind: 'text', text: 'Signed loop progress · no transcript lookup' },
    { kind: 'tool_call', callId: 'call-1', name: 'inspect', args: { scope: 'fixture' } },
    { kind: 'tool_result', callId: 'call-1', result: { passed: true } },
    { kind: 'artifact', ref: 'artifact:fixture-report', name: 'Fixture report', mediaType: 'text/plain' },
    { kind: 'decision', decision: 'continue', reason: 'Awaiting operator wish' },
    { kind: 'approval_request', approvalId: 'native-allow', action: 'Run fixture tests', details: { command: 'pnpm test' } },
    { kind: 'spawn', loopId: 'fixture-example-child' },
    { kind: 'model_change', model: 'fixture-model', previousModel: 'fixture-previous' },
    { kind: 'text', artifactRef: { id: 'fixture-stored', sha256: 'f'.repeat(64), byteLength: 24000, mediaType: 'application/json' },
      preview: 'Stored redacted output preview', truncated: true },
  ];
}

function fixtureApproval(proposalId: string, approvalId: string): OperatorApprovalCard {
  return { proposalId, source: 'gateway-exec', kind: 'gateway-exec:command', summary: `Fixture native approval ${approvalId}`,
    keysTouched: [], detail: { command: 'pnpm test', host: 'fixture', cwd: '/fixture', approvalId },
    contentHash: 'f'.repeat(64), status: 'pending', decision: null, outcome: null, appliedAt: null,
    createdAt: new Date().toISOString(), sessionBinding: { loopId: 'fixture-session', principalDid: principal, agentDid: agent, approvalId } };
}

/** Local fixture only. All API calls are intercepted; production code and auth are unchanged. */
export async function createRunsPreviewTransport(horizonState = 'active') {
  if (process.env.NODE_ENV !== 'development') throw new Error('Development fixture only');
  const principalKey = crypto.getRandomValues(new Uint8Array(32));
  const kernelKey = crypto.getRandomValues(new Uint8Array(32));
  const agentKey = crypto.getRandomValues(new Uint8Array(32));
  const principalPublic = await ed.getPublicKeyAsync(principalKey);
  const kernelPublic = await ed.getPublicKeyAsync(kernelKey);
  const agentPublic = await ed.getPublicKeyAsync(agentKey);
  const loops = [fixtureLoop('fixture-session', 'openclaw.session'), fixtureLoop('fixture-warp', 'warp.run')];
  const horizon = createHorizonFixture('fixture-session', principal, agent);
  const lastStepEventAt = horizonState === 'unpublished' ? null : new Date().toISOString();
  loops[0].state = 'blocked';
  loops[0].lastEventType = 'loop.blocked';
  const events: LoopEventJson[] = fixtureOutputs().map((output, index) => ({
    id: `fixture-output-${index}`, loopId: 'fixture-session', type: 'loop.progress', issuer: agent, principal,
    payload: { output }, occurredAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  }));
  const approvals = [fixtureApproval('fixture-allow', 'native-allow'), fixtureApproval('fixture-deny', 'native-deny')];
  const bindingProofs = await Promise.all(approvals.map(async (card) => {
    const unsigned = { from: agent, type: 'agent', timestamp: Date.now(), payload: card.sessionBinding };
    return { type: 'loop.approval.bound', attestation: {
      ...unsigned, signature: ed.etc.bytesToHex(await ed.signAsync(encode(unsigned), agentKey)),
    } };
  }));
  const proofs: Record<string, unknown>[] = [];
  const prepared = new Map<string, SessionCommandFrame>();
  const used = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const signature = async (body: unknown, key: Uint8Array, publicKey: Uint8Array) => ({
    keyId: ed.etc.bytesToHex(publicKey), alg: 'ed25519' as const, sig: ed.etc.bytesToHex(await ed.signAsync(encode(body), key)),
  });
  async function outcome(command: SessionCommandFrame, parent: string) {
    const spawn = command.type === 'session.spawn';
    const loopId = spawn ? `fixture-child-${command.commandId}` : parent;
    const eventType = `loop.${command.type}.completed`;
    const payloadHash = ed.etc.bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(command.payload))));
    const payload = { eventType, commandId: command.commandId, command: command.type, outcome: 'completed',
      principal, issuer, agentDid: agent, payloadHash, at: new Date().toISOString(), loopId,
      parentLoopId: spawn ? parent : null, ...(spawn ? { childLoopId: loopId } : {}) };
    const native = approvals.find((card) => card.sessionBinding?.approvalId === command.payload.approvalId);
    if (native) Object.assign(payload, { approvalId: native.sessionBinding!.approvalId, approvalKind: 'exec' });
    const unsigned = { from: agent, type: 'agent', timestamp: Date.now(), payload };
    const attestation = { ...unsigned, signature: ed.etc.bytesToHex(await ed.signAsync(encode(unsigned), agentKey)) };
    if (!await ed.verifyAsync(ed.etc.hexToBytes(attestation.signature), encode(unsigned), agentPublic)) throw new Error('Invalid fixture proof');
    proofs.push({ type: eventType, attestation });
    events.push({ id: `outcome-${command.commandId}`, loopId: parent, type: eventType, issuer: agent, principal, payload,
      occurredAt: payload.at, createdAt: payload.at });
    if (spawn) loops.push(fixtureLoop(loopId, 'openclaw.subagent', parent));
    if (command.type === 'session.send') horizon.observeClaim(command.payload.message);
    if (native) native.sessionOutcome = { commandId: command.commandId, outcome: 'completed', at: payload.at };
  }
  async function commandRequest(loopId: string, data: Record<string, unknown>, approvalRail = false) {
    if (data.action === 'prepare') {
      const body: SessionCommandBody = { type: data.type as SessionCommandBody['type'], payload: data.payload as Record<string, string>,
        commandId: crypto.randomUUID(), to: agent, principal, issuer, issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString() };
      const command = { ...body, signature: await signature(body, kernelKey, kernelPublic) };
      prepared.set(command.commandId, command);
      return json({ command });
    }
    const command = data.command as SessionCommandFrame;
    if (command.payload.approvalId && !approvalRail) return json({ error: 'Use existing approval decision endpoint' }, 403);
    const expected = prepared.get(command.commandId);
    if (!expected || used.has(command.commandId) || !command.countersignature) return json({ error: 'Unprepared or replayed command' }, 409);
    const validWish = await ed.verifyAsync(ed.etc.hexToBytes(command.countersignature.sig), encode(commandBody(command)), principalPublic);
    const validGrant = await ed.verifyAsync(ed.etc.hexToBytes(command.signature.sig), encode(commandBody(command)), kernelPublic);
    if (!validWish || !validGrant || canonicalCommandJson(commandBody(command)) !== canonicalCommandJson(commandBody(expected))) return json({ error: 'Invalid full-body signatures' }, 403);
    used.add(command.commandId);
    // Deliberately later than delivery: transport acceptance is not execution.
    const timer = setTimeout(() => { timers.delete(timer); void outcome(command, loopId); }, 500);
    timers.add(timer);
    return json({ commandId: command.commandId, delivered: true });
  }
  async function approvalDecision(proposalId: string, data: Record<string, unknown>) {
    const card = approvals.find((item) => item.proposalId === proposalId);
    if (!card) return json({ error: 'Not found' }, 404);
    const command = data.sessionCommand as SessionCommandFrame | undefined;
    const expectedType = data.decision === 'approve' ? 'session.approve' : 'session.deny';
    if (command?.type !== expectedType || command.payload.approvalId !== card.sessionBinding?.approvalId) {
      return json({ error: 'Complete bound wish required' }, 400);
    }
    const result = await commandRequest('fixture-session', { action: 'dispatch', command }, true);
    if (!result.ok) return result;
    card.status = data.decision === 'approve' ? 'approved' : 'denied';
    return json({ approval: card, sessionCommand: await result.json() });
  }
  const fetcher = async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const url = fixtureUrl(input);
    if (url.pathname === '/jin/api/operator-approvals') return json({ isOperator: true, approvals });
    const decision = /^\/jin\/api\/operator-approvals\/([^/]+)\/decision$/.exec(url.pathname);
    if (decision) return approvalDecision(decodeURIComponent(decision[1]), await fixtureBody(input, options));
    if (url.pathname === '/api/loops/surfaces') return json({ leases: [], warnOnly: true, conflicts: [{
      id: 'fixture-conflict', loopId: 'fixture-session', type: 'surface.conflicted', payload: {
        loopId: 'fixture-session', surface: 'issue:#2404', refs: { conflictingLoopId: 'fixture-warp' },
      },
    }] });
    if (url.pathname === '/jin/api/runs') return json({ isOperator: true, page: { loops, hasNextPage: false, nextCursor: null } });
    if (url.pathname === '/jin/api/runs/horizon-status') return json({ isOperator: true, lastStepEventAt });
    const match = /^\/jin\/api\/runs\/([^/]+)(\/commands)?$/.exec(url.pathname);
    if (!match) return json({ error: 'Fixture has no external transport' }, 404);
    const loopId = decodeURIComponent(match[1]);
    if (match[2]) return commandRequest(loopId, await fixtureBody(input, options));
    const loop = loops.find((item) => item.loopId === loopId);
    if (!loop) return json({ error: 'Not found' }, 404);
    return json({ isOperator: true, detail: { loop, events: events.filter((event) => event.loopId === loopId),
      horizon: loopId === 'fixture-session' && horizonState === 'active' ? horizon.read() : { steps: [], depth: 0, targetDepth: 12 } },
      commandTarget: { available: loop.kind !== 'warp.run', agentDid: agent } });
  };
  return { fetcher, proofs, bindingProofs, agentPublicKey: ed.etc.bytesToHex(agentPublic),
    dispose: () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
    keypair: { privateKey: ed.etc.bytesToHex(principalKey), publicKey: ed.etc.bytesToHex(principalPublic) } };
}

export async function installRunsPreview() {
  const requested = new URLSearchParams(window.location.search).get('horizon');
  const fixture = await createRunsPreviewTransport(requested === 'unpublished' || requested === 'drained' ? requested : 'active');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetcher;
  const client: SessionCommandClient = {
    prepare: (loopId, type, payload) => prepareSignedSessionCommand(loopId, type, payload, fixture.keypair),
    dispatch: dispatchSessionCommand,
  };
  return { client, dispose: () => { fixture.dispose(); globalThis.fetch = previousFetch; } };
}
