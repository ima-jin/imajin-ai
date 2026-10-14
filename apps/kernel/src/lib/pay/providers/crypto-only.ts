import { SolanaProvider } from './solana';

/** Construct only the crypto adapter; payment-service initialization probes platform Stripe. */
export function getCryptoOnlyProvider(): SolanaProvider {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('Solana provider not configured');
  return new SolanaProvider({ rpcUrl });
}
