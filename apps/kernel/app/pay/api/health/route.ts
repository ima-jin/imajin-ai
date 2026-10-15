/**
 * GET /api/health
 * 
 * Health check endpoint - checks all configured providers.
 */

import { NextResponse } from 'next/server';
import { getPaymentService } from '@/src/lib/pay/pay';
import { isNodeCardRailConfigured } from '@/src/lib/pay/providers/node-card-rail';
import type { HealthCheckResult } from '@/src/lib/pay/providers/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cardReady = await isNodeCardRailConfigured();
    const health: Record<string, HealthCheckResult> = process.env.SOLANA_RPC_URL
      ? await getPaymentService().healthCheck()
      : {};
    health.stripe = {
      healthy: cardReady,
      ...(!cardReady && { message: 'Card rail not configured for this node' }),
    };
    
    const allHealthy = Object.values(health).every(h => h.healthy);
    
    return NextResponse.json({
      status: allHealthy ? 'healthy' : 'degraded',
      providers: health,
      version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
      build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
      timestamp: new Date().toISOString(),
    }, {
      status: allHealthy ? 200 : 503,
    });
  } catch {
    return NextResponse.json({
      status: 'unhealthy',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
}
