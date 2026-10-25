import { isSshCaPurpose, SSH_CA_DEFAULT_CERT_TTL_SECONDS, SSH_CA_MAX_CERT_TTL_SECONDS } from './ssh-ca-policy';
import { parseSshPublicKey } from './ssh-cert-wire';
import { SshCaError } from './ssh-ca';
import type { SshScope } from './ssh-cert';

export interface SshSignInput {
  purpose: string; caId: string; grantId: string; publicKey: string;
  principal: string; host: string; job: string; ttl: number;
}
export const isSshPrincipal = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,63}$/.test(value);
export const isSshHost = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
export const isCaId = (value: unknown): value is string =>
  typeof value === 'string' && /^vmk_[a-zA-Z0-9_-]{1,100}$/.test(value);

export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SshCaError(400, 'Invalid SSH input');
  return input as Record<string, unknown>;
}
export function onlyKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new SshCaError(400, 'Unexpected SSH input property');
}
export function parseSignInput(input: unknown): SshSignInput {
  const body = objectInput(input);
  onlyKeys(body, ['purpose', 'caId', 'grantId', 'publicKey', 'principal', 'host', 'job', 'ttl']);
  const ttl = body.ttl === undefined ? SSH_CA_DEFAULT_CERT_TTL_SECONDS : body.ttl;
  if (!isSshCaPurpose(body.purpose) || !isCaId(body.caId)
    || typeof body.grantId !== 'string' || !/^vdg_[a-zA-Z0-9_-]{1,100}$/.test(body.grantId)
    || !parseSshPublicKey(body.publicKey) || !isSshPrincipal(body.principal) || !isSshHost(body.host)
    || typeof body.job !== 'string' || !/^[a-zA-Z0-9:/._-]{1,200}$/.test(body.job)
    || typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > SSH_CA_MAX_CERT_TTL_SECONDS) {
    throw new SshCaError(400, 'Invalid SSH certificate request');
  }
  return { ...body, ttl } as unknown as SshSignInput;
}

export function validSshScope(scope: SshScope): boolean {
  return isCaId(scope.caId) && Array.isArray(scope.principals)
    && scope.principals.length > 0 && scope.principals.length <= 16 && scope.principals.every(isSshPrincipal)
    && Array.isArray(scope.allowedHosts) && scope.allowedHosts.length > 0
    && scope.allowedHosts.length <= 64 && scope.allowedHosts.every(isSshHost)
    && typeof scope.forceCommand === 'string' && scope.forceCommand.trim().length > 0
    && scope.forceCommand.length <= 2048 && !/[\0\r\n]/.test(scope.forceCommand);
}
