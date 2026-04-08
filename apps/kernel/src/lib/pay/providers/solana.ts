/**
 * Solana Payment Provider
 * 
 * Implements PaymentProvider for Solana (crypto payments).
 * 
 * Capabilities:
 * - SOL transfers
 * - SPL token transfers (USDC, MJN)
 * - Escrow via program (future)
 * 
 * Note: This provider returns unsigned transactions.
 * The caller is responsible for signing with their wallet.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { PaymentProvider, HealthCheckResult, ProviderCapabilities } from './types';
import type {
  SolanaProviderConfig,
  ChargeRequest,
  ChargeResult,
  EscrowRequest,
  EscrowResult,
  Recipient,
} from '../types';

/** USDC mint address on mainnet */
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDC mint address on devnet */
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export class SolanaProvider implements PaymentProvider {
  readonly name = 'solana' as const;
  
  readonly capabilities: ProviderCapabilities = {
    charge: true,
    checkout: false,      // No hosted checkout for crypto
    escrow: false,        // TODO: Implement escrow program
    subscriptions: false, // No native subscriptions on Solana
    refunds: false,       // Blockchain is immutable
  };
  
  private connection: Connection;
  private config: SolanaProviderConfig;
  
  constructor(config: SolanaProviderConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment || 'confirmed',
    });
  }
  
  // ===========================================================================
  // Health Check
  // ===========================================================================
  
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const slot = await this.connection.getSlot();
      return {
        healthy: true,
        message: `Current slot: ${slot}`,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - start,
      };
    }
  }
  
  // ===========================================================================
  // Charge
  // ===========================================================================
  
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const recipientAddress = this.resolveRecipient(request.to);
    
    // Validate recipient address
    try {
      new PublicKey(recipientAddress);
    } catch {
      throw new Error(`Invalid Solana address: ${recipientAddress}`);
    }
    
    // Route based on currency
    switch (request.currency) {
      case 'SOL':
        return this.prepareSOLTransfer(request, recipientAddress);
      case 'USDC':
        return this.prepareSPLTransfer(request, recipientAddress, this.getUSDCMint());
      case 'MJN':
        // MJN token not yet deployed
        throw new Error('MJN token not yet available');
      default:
        throw new Error(`Unsupported currency for Solana: ${request.currency}`);
    }
  }
  
  private async prepareSOLTransfer(request: ChargeRequest, to: string): Promise<ChargeResult> {
    // Note: We don't execute the transfer here.
    // We return instructions for the caller to sign and send.
    // This is the standard pattern for wallet integration.
    
    const lamports = request.amount; // Caller should provide lamports directly
    
    return {
      id: `sol-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      provider: 'solana',
      status: 'requires_action',
      amount: request.amount,
      currency: 'SOL',
      createdAt: new Date(),
      metadata: {
        ...request.metadata,
        recipientAddress: to,
        lamports: lamports.toString(),
        instruction: 'sign_and_send',
        type: 'SOL_TRANSFER',
      },
    };
  }
  
  private async prepareSPLTransfer(request: ChargeRequest, to: string, mint: string): Promise<ChargeResult> {
    // Similar to SOL - return instructions for caller to execute
    
    return {
      id: `spl-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      provider: 'solana',
      status: 'requires_action',
      amount: request.amount,
      currency: request.currency,
      createdAt: new Date(),
      metadata: {
        ...request.metadata,
        recipientAddress: to,
        mintAddress: mint,
        instruction: 'sign_and_send',
        type: 'SPL_TRANSFER',
      },
    };
  }
  
  // ===========================================================================
  // Escrow (Future)
  // ===========================================================================
  
  async escrow(_request: EscrowRequest): Promise<EscrowResult> {
    // TODO: Implement escrow via custom Solana program
    // Options:
    // 1. Custom escrow program (most flexible)
    // 2. Integrate existing (Streamflow, etc.)
    // 3. Multi-sig approach
    throw new Error('Solana escrow not yet implemented');
  }
  
  // ===========================================================================
  // Helpers
  // ===========================================================================
  
  private resolveRecipient(recipient: Recipient): string {
    if ('solanaAddress' in recipient) {
      return recipient.solanaAddress;
    }
    
    if ('did' in recipient) {
      // TODO: Integrate with @imajin/auth to resolve DID → Solana address
      throw new Error('DID resolution not yet implemented. Use solanaAddress directly.');
    }
    
    throw new Error('Invalid recipient for Solana provider');
  }
  
  private getUSDCMint(): string {
    // Detect network from RPC URL
    if (this.config.rpcUrl.includes('devnet')) {
      return USDC_MINT_DEVNET;
    }
    return USDC_MINT_MAINNET;
  }
  
  // ===========================================================================
  // Utility Methods (for callers)
  // ===========================================================================
  
  /** Get connection for advanced operations */
  getConnection(): Connection {
    return this.connection;
  }
  
  /** Convert SOL to lamports */
  static solToLamports(sol: number): number {
    return Math.round(sol * LAMPORTS_PER_SOL);
  }
  
  /** Convert lamports to SOL */
  static lamportsToSol(lamports: number): number {
    return lamports / LAMPORTS_PER_SOL;
  }
  
  /** Convert USDC to base units (6 decimals) */
  static usdcToBaseUnits(usdc: number): number {
    return Math.round(usdc * 1_000_000);
  }
  
  /** Convert base units to USDC */
  static baseUnitsToUsdc(baseUnits: number): number {
    return baseUnits / 1_000_000;
  }
}
