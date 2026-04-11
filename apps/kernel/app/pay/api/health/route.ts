/**
 * GET /api/health
 * 
 * Health check endpoint - checks all configured providers.
 */

import { NextResponse } from 'next/server';
import { getPaymentService } from '@/src/lib/pay/pay';

export async function GET() {
  try {
    const pay = getPaymentService();
    const health = await pay.healthCheck();
    
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
  } catch (error) {
    return NextResponse.json({
      status: 'unhealthy',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
}
