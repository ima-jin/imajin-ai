import * as ed from '@noble/ed25519';
import type { LoopJson, LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandBody, SessionCommandFrame } from '@/src/lib/jin/session-command-contract';
import { canonicalCommandJson, prepareSignedSessionCommand, dispatchSessionCommand, type SessionCommandClient } from '@/app/jin/session-command-client';

const principal = 'did:imajin:fixture-principal';
const agent = 'did:imajin:fixture-agent';
const issuer = 'did:imajin:fixture-kernel';
const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(canonicalCommandJson(value));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

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

/** Local fixture only. All API calls are intercepted; production code and auth are unchanged. */
export async function createRunsPreviewTransport() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Development fixture only');
  const principalKey = crypto.getRandomValues(new Uint8Array(32));
  const kernelKey = crypto.getRandomValues(new Uint8Array(32));
  const agentKey = crypto.getRandomValues(new Uint8Array(32));
  const principalPublic = await ed.getPublicKeyAsync(principalKey);
  const kernelPublic = await ed.getPublicKeyAsync(kernelKey);
  const agentPublic = await ed.getPublicKeyAsync(agentKey);
  const loops = [fixtureLoop('fixture-session', 'openclaw.session'), fixtureLoop('fixture-warp', 'warp.run')];
  loops[0].state = 'blocked';
  loops[0].lastEventType = 'loop.blocked';
  const events: LoopEventJson[] = [];
  const proofs: Record<string, unknown>[] = [];
  const prepared = new Map<string, SessionCommandFrame>();
  const used = new Set<string>();
  const signature = async (body: unknown, key: Uint8Array, publicKey: Uint8Array) => ({
    keyId: ed.etc.bytesToHex(publicKey), alg: 'ed25519' as const, sig: ed.etc.bytesToHex(await ed.signAsync(encode(body), key)),
  });
  async function outcome(command: SessionCommandFrame, parent: string) {
    const spawn = command.type === 'session.spawn';
    const loopId = spawn ? `fixture-child-${used.size}` : parent;
    const eventType = `loop.${command.type}.completed`;
    const payloadHash = ed.etc.bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(command.payload))));
    const payload = { eventType, commandId: command.commandId, command: command.type, outcome: 'completed',
      principal, issuer, agentDid: agent, payloadHash, at: new Date().toISOString(), loopId,
      parentLoopId: spawn ? parent : null, ...(spawn ? { childLoopId: loopId } : {}) };
    const unsigned = { from: agent, type: 'agent', timestamp: Date.now(), payload };
    const attestation = { ...unsigned, signature: ed.etc.bytesToHex(await ed.signAsync(encode(unsigned), agentKey)) };
    if (!await ed.verifyAsync(ed.etc.hexToBytes(attestation.signature), encode(unsigned), agentPublic)) throw new Error('Invalid fixture proof');
    proofs.push({ type: eventType, attestation });
    events.push({ id: `outcome-${command.commandId}`, loopId: parent, type: eventType, issuer: agent, principal, payload,
      occurredAt: payload.at, createdAt: payload.at });
    if (spawn) loops.push(fixtureLoop(loopId, 'openclaw.subagent', parent));
  }
  async function commandRequest(loopId: string, data: Record<string, unknown>) {
    if (data.action === 'prepare') {
      const body: SessionCommandBody = { type: data.type as SessionCommandBody['type'], payload: data.payload as Record<string, string>,
        commandId: crypto.randomUUID(), to: agent, principal, issuer, issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString() };
      const command = { ...body, signature: await signature(body, kernelKey, kernelPublic) };
      prepared.set(command.commandId, command);
      return json({ command });
    }
    const command = data.command as SessionCommandFrame;
    const expected = prepared.get(command.commandId);
    if (!expected || used.has(command.commandId) || !command.countersignature) return json({ error: 'Unprepared or replayed command' }, 409);
    const validWish = await ed.verifyAsync(ed.etc.hexToBytes(command.countersignature.sig), encode(commandBody(command)), principalPublic);
    const validGrant = await ed.verifyAsync(ed.etc.hexToBytes(command.signature.sig), encode(commandBody(command)), kernelPublic);
    if (!validWish || !validGrant || canonicalCommandJson(commandBody(command)) !== canonicalCommandJson(commandBody(expected))) return json({ error: 'Invalid full-body signatures' }, 403);
    used.add(command.commandId);
    // Deliberately later than delivery: transport acceptance is not execution.
    setTimeout(() => { void outcome(command, loopId); }, 500);
    return json({ commandId: command.commandId, delivered: true });
  }
  const fetcher = async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://fixture.local');
    if (url.pathname === '/jin/api/operator-approvals') return json({ isOperator: true, approvals: [] });
    if (url.pathname === '/api/loops/surfaces') return json({ leases: [], warnOnly: true, conflicts: [{
      id: 'fixture-conflict', loopId: 'fixture-session', type: 'surface.conflicted', payload: {
        loopId: 'fixture-session', surface: 'issue:#2404', refs: { conflictingLoopId: 'fixture-warp' },
      },
    }] });
    if (url.pathname === '/jin/api/runs') return json({ isOperator: true, page: { loops, hasNextPage: false, nextCursor: null } });
    const match = /^\/jin\/api\/runs\/([^/]+)(\/commands)?$/.exec(url.pathname);
    if (!match) return json({ error: 'Fixture has no external transport' }, 404);
    const loopId = decodeURIComponent(match[1]);
    if (match[2]) return commandRequest(loopId, JSON.parse(String(options?.body)) as Record<string, unknown>);
    const loop = loops.find((item) => item.loopId === loopId);
    if (!loop) return json({ error: 'Not found' }, 404);
    return json({ isOperator: true, detail: { loop, events: events.filter((event) => event.loopId === loopId) },
      commandTarget: { available: loop.kind !== 'warp.run', agentDid: agent } });
  };
  return { fetcher, proofs, keypair: { privateKey: ed.etc.bytesToHex(principalKey), publicKey: ed.etc.bytesToHex(principalPublic) } };
}

export async function installRunsPreview() {
  const fixture = await createRunsPreviewTransport();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetcher;
  const client: SessionCommandClient = {
    prepare: (loopId, type, payload) => prepareSignedSessionCommand(loopId, type, payload, fixture.keypair),
    dispatch: dispatchSessionCommand,
  };
  return { client, dispose: () => { globalThis.fetch = previousFetch; } };
}
