import { NextResponse } from 'next/server';
import { requireMintAuthority } from './mint-authority';
import { isSshCaPurpose } from './ssh-ca-policy';
import { mintSshCa, revokeSshCa, SshCaError } from './ssh-ca';

export const sshCaJson = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Never serialize or log an upstream error: custody exceptions may carry secrets. */
export function sshCaFailure(error: unknown) {
  return error instanceof SshCaError
    ? sshCaJson({ error: error.message }, error.status)
    : sshCaJson({ error: 'SSH CA unavailable' }, 503);
}

export async function mutateSshCa(request: Request, action: 'mint' | 'rotate' | 'revoke') {
  const auth = await requireMintAuthority(request);
  if (!auth.ok) return auth.response;
  let input: unknown;
  try { input = await request.json(); }
  catch { return sshCaJson({ error: 'Invalid JSON' }, 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return sshCaJson({ error: 'Invalid SSH CA input' }, 400);
  }
  const body = input as Record<string, unknown>;
  const allowed = action === 'revoke' ? ['purpose', 'caId'] : ['purpose'];
  if (Object.keys(body).some(key => !allowed.includes(key)) || !isSshCaPurpose(body.purpose)) {
    return sshCaJson({ error: 'Expected a canonical purpose (1–64 lowercase letters, digits, dot, underscore or hyphen)' }, 400);
  }
  if (action === 'revoke' && (typeof body.caId !== 'string' || !/^vmk_[a-zA-Z0-9_-]{1,100}$/.test(body.caId))) {
    return sshCaJson({ error: 'Invalid CA id' }, 400);
  }
  try {
    return action === 'revoke'
      ? sshCaJson(await revokeSshCa(body.purpose, body.caId as string, auth.authority))
      : sshCaJson(await mintSshCa(body.purpose, auth.authority, action === 'rotate'), 201);
  } catch (error) {
    return sshCaFailure(error);
  }
}
