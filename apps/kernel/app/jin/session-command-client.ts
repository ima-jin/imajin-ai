'use client';

import type { SessionCommandFrame, SessionCommandType } from '@/src/lib/jin/session-command-contract';

export function canonicalCommandJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCommandJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort((a, b) => a.localeCompare(b)).map((key) =>
      `${JSON.stringify(key)}:${canonicalCommandJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytes(hex: string) {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('A signing key is required in this browser.');
  return Uint8Array.from(hex.match(/../g)!, (part) => Number.parseInt(part, 16));
}

async function commandRequest(loopId: string, body: unknown) {
  const response = await fetch(`/jin/api/runs/${encodeURIComponent(loopId)}/commands`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Authorization changed. Refresh Runs before trying again.');
    throw new Error(`Command unavailable (${response.status}). No execution confirmed.`);
  }
  return response.json();
}

export async function prepareSignedSessionCommand(
  loopId: string, type: SessionCommandType, payload: Record<string, unknown>,
  fixtureKeypair?: { privateKey: string; publicKey: string },
): Promise<SessionCommandFrame> {
  const stored = fixtureKeypair ? JSON.stringify(fixtureKeypair) : localStorage.getItem('imajin_keypair');
  if (!stored) throw new Error('A signing key is required in this browser.');
  let key: { privateKey: string; publicKey: string };
  try { key = JSON.parse(stored); } catch { throw new Error('A signing key is required in this browser.'); }
  const privateKey = bytes(key.privateKey);
  bytes(key.publicKey);
  const { command } = await commandRequest(loopId, { action: 'prepare', type, payload }) as { command: SessionCommandFrame };
  if (command.type !== type || canonicalCommandJson(command.payload) !== canonicalCommandJson(payload)) {
    throw new Error('Prepared command does not match your request.');
  }
  const { type: commandType, commandId, to, principal, issuer, issuedAt, expiresAt } = command;
  const body = { type: commandType, commandId, to, principal, issuer, issuedAt, expiresAt: expiresAt ?? null, payload: command.payload };
  const ed = await import('@noble/ed25519');
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalCommandJson(body)), privateKey);
  const signature = Array.from(sig, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...command, countersignature: { keyId: key.publicKey, alg: 'ed25519', sig: signature } };
}

export async function dispatchSessionCommand(loopId: string, command: SessionCommandFrame): Promise<{ commandId: string; delivered: boolean }> {
  return commandRequest(loopId, { action: 'dispatch', command });
}

export interface SessionCommandClient {
  prepare: typeof prepareSignedSessionCommand;
  dispatch: typeof dispatchSessionCommand;
}

export const browserSessionCommands: SessionCommandClient = {
  prepare: prepareSignedSessionCommand, dispatch: dispatchSessionCommand,
};
