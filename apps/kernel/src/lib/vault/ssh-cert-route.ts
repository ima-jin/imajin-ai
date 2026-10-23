import { requireAuth } from '@imajin/auth';
import { requireMintAuthority } from './mint-authority';
import { sshCaFailure, sshCaJson } from './ssh-ca-route';
import { SshCaError } from './ssh-ca';
import { isSshCaPurpose } from './ssh-ca-policy';
import { objectInput, onlyKeys, parseSignInput } from './ssh-cert-policy';
import { issueSshGrant, recordSshRefusal, revokeSshGrant, signSshCert, type SshScope } from './ssh-cert';

async function readInput(request: Request) {
  try { return await request.json(); }
  catch { throw new SshCaError(400, 'Invalid JSON'); }
}

export async function signSshCertRoute(request: Request) {
  let grantee: string | null = null;
  try {
    const auth = await requireAuth(request);
    if ('error' in auth) throw new SshCaError(auth.status, 'Authentication required');
    // The authenticated credential is the grantee. Acting-for cannot borrow a grant.
    grantee = auth.identity.id;
    const input = parseSignInput(await readInput(request));
    return sshCaJson(await signSshCert(input, grantee), 201);
  } catch (error) {
    try { await recordSshRefusal(grantee, error instanceof SshCaError ? error.status : 503); }
    catch { return sshCaFailure(new Error('Audit unavailable')); }
    return sshCaFailure(error);
  }
}

export async function sshGrantRoute(request: Request, revoke = false) {
  try {
    const auth = await requireMintAuthority(request);
    if (!auth.ok) return auth.response;
    const body = objectInput(await readInput(request));
    onlyKeys(body, revoke ? ['purpose', 'grantId']
      : ['purpose', 'grantee', 'caId', 'principals', 'forceCommand', 'allowedHosts', 'expiresAt']);
    if (!isSshCaPurpose(body.purpose)) throw new SshCaError(400, 'Invalid SSH CA purpose');
    if (revoke) {
      if (typeof body.grantId !== 'string' || !/^vdg_[a-zA-Z0-9_-]{1,100}$/.test(body.grantId)) {
        throw new SshCaError(400, 'Invalid SSH grant id');
      }
      return sshCaJson(await revokeSshGrant(body.purpose, body.grantId, auth.authority));
    }
    if (typeof body.grantee !== 'string' || typeof body.expiresAt !== 'string') {
      throw new SshCaError(400, 'Grantee and expiry required');
    }
    const scope = { caId: body.caId, principals: body.principals, forceCommand: body.forceCommand,
      allowedHosts: body.allowedHosts } as SshScope;
    return sshCaJson(await issueSshGrant(body.purpose, body.grantee, scope, new Date(body.expiresAt), auth.authority), 201);
  } catch (error) { return sshCaFailure(error); }
}
