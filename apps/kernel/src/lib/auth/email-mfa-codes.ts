import { randomInt } from 'crypto';
const emailMfaCodes = new Map<string, { code: string; expiresAt: number }>();

export function generateEmailMfaCode(): string {
  return randomInt(100000, 1000000).toString();
}

export function storeEmailMfaCode(did: string, code: string): void {
  emailMfaCodes.set(did, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
}

export function verifyEmailMfaCode(did: string, code: string): boolean {
  const entry = emailMfaCodes.get(did);
  if (!entry || Date.now() > entry.expiresAt) {
    emailMfaCodes.delete(did);
    return false;
  }
  if (entry.code !== code) return false;
  emailMfaCodes.delete(did);
  return true;
}
