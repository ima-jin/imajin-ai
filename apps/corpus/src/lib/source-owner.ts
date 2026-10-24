import { resolveCorpusDid as resolveSourceDid } from '@imajin/auth';
import { getAttestationInternalApiKey, markAttestationKeyUsedForForwarding } from './attestation-key';

export function resolveCorpusDid(source: string, principalDid: string, options: { createIfMissing?: boolean } = {}): Promise<string> {
  return resolveSourceDid(source, principalDid, async () => {
    const key = getAttestationInternalApiKey();
    const authUrl = process.env.AUTH_SERVICE_URL;
    if (!key || !authUrl) throw new Error('Corpus identity resolver is not configured');
    const response = await fetch(`${authUrl}/api/internal/corpus/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ source, principalDid, ...(options.createIfMissing === false ? { createIfMissing: false } : {}) }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Corpus identity resolver unavailable');
    const result = await response.json() as { did?: unknown };
    if (typeof result.did !== 'string' || !result.did.startsWith('did:imajin:')) throw new Error('Invalid corpus owner identity');
    markAttestationKeyUsedForForwarding();
    return result.did;
  });
}
