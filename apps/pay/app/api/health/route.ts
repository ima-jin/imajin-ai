/**
 * GET /api/health
 * 
 * Health check endpoint - checks all configured providers.
 */

import { NextResponse } from 'next/server';
import { getPaymentService } from '@/lib/pay';

export async function GET() {
  try {
    const pay = getPaymentService();
    const health = await pay.healthCheck();
    
    const allHealthy = Object.values(health).every(h => h.healthy);
    
    return NextResponse.json({
      status: allHealthy ? 'healthy' : 'degraded',
      providers: health,
      timestamp: new Date().toISOString(),
    }, {
      status: allHealthy ? 200 : 503,
    });
  } catch (error) {
    return NextResponse.json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
}
