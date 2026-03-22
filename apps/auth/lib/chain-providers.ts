import { dfosProvider } from './providers/dfos';

export interface ChainVerificationResult {
  valid: boolean;
  did?: string;
  publicKeyMultibase?: string;
  publicKeyHex?: string;
  keyCount?: number;
  providerName?: string;
  error?: string;
}

export interface ChainProvider {
  name: string;
  /** Returns true if this provider recognises the chain log format. */
  canVerify(chainLog: string[]): boolean;
  /** Cryptographically verify the chain and return normalised result. */
  verify(chainLog: string[]): Promise<ChainVerificationResult>;
  /** Synchronously extract the DID — may throw if provider requires async. */
  extractDid(chainLog: string[]): string;
  /** Synchronously extract the public key — may throw if provider requires async. */
  extractPublicKey(chainLog: string[]): string;
}

/**
 * Registered chain providers, in detection priority order.
 * Adding a new provider = implement ChainProvider + push here.
 */
const providers: ChainProvider[] = [
  dfosProvider, // @imajin/dfos — first and only provider for now
];

/**
 * Resolve the correct provider for a chain log and verify it.
 * Returns an error result if no provider recognises the format.
 */
export async function verifyChainLog(chainLog: string[]): Promise<ChainVerificationResult> {
  if (!Array.isArray(chainLog) || chainLog.length === 0) {
    return { valid: false, error: 'chainLog must be a non-empty array' };
  }

  const provider = providers.find(p => p.canVerify(chainLog));
  if (!provider) {
    return { valid: false, error: 'Unrecognised chain format — no provider matched' };
  }

  return provider.verify(chainLog);
}

/**
 * Detect which provider would handle this chain log (without verifying).
 * Returns null if no provider recognises the format.
 */
export function detectProvider(chainLog: string[]): ChainProvider | null {
  return providers.find(p => p.canVerify(chainLog)) ?? null;
}
