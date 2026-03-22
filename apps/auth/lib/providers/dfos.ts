import { verifyChain } from '@imajin/dfos';
import { multibaseToHex } from '@imajin/auth';
import type { ChainProvider, ChainVerificationResult } from '../chain-providers';

/**
 * Detect DFOS chain log format.
 * DFOS chains use JWS compact serialization — entries are base64url strings
 * with the standard "eyJ..." prefix and period delimiters.
 */
function isDfosChainLog(chainLog: string[]): boolean {
  if (chainLog.length === 0) return false;
  const first = chainLog[0];
  return typeof first === 'string' && first.startsWith('eyJ') && first.includes('.');
}

export const dfosProvider: ChainProvider = {
  name: 'dfos',

  canVerify(chainLog: string[]): boolean {
    return isDfosChainLog(chainLog);
  },

  async verify(chainLog: string[]): Promise<ChainVerificationResult> {
    try {
      const verified = await verifyChain(chainLog);

      if (verified.isDeleted) {
        return { valid: false, error: 'Chain has been deleted' };
      }

      const publicKeyMultibase = verified.controllerKeys[0]?.publicKeyMultibase;
      const publicKeyHex = publicKeyMultibase ? multibaseToHex(publicKeyMultibase) : undefined;

      return {
        valid: true,
        did: verified.did,
        publicKeyMultibase,
        publicKeyHex,
        keyCount: chainLog.length,
        providerName: 'dfos',
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Chain verification failed',
      };
    }
  },

  extractDid(_chainLog: string[]): string {
    throw new Error('dfosProvider.extractDid: use verify() — DID extraction requires async verification');
  },

  extractPublicKey(_chainLog: string[]): string {
    throw new Error('dfosProvider.extractPublicKey: use verify() — key extraction requires async verification');
  },
};
