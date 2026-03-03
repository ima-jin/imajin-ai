import { NextRequest } from 'next/server';

/**
 * CORS headers for cross-origin requests from *.imajin.ai
 */
export function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  // Allow any *.imajin.ai subdomain + localhost in dev
  const isImajin = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  const isLocalhost = origin.startsWith('http://localhost:');
  const allowed = isImajin || isLocalhost;
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
