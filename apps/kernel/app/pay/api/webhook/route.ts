/**
 * The former node-account endpoint has no connector binding. Never select a
 * signing secret from unverified event metadata or fall back to node credentials.
 * Owners configure /pay/api/webhook/did/{routingId} through their connector.
 */
import { NextResponse } from 'next/server';

export function POST(_request: Request) {
  return Promise.resolve(NextResponse.json({ error: 'A connector-bound webhook endpoint is required' }, { status: 400 }));
}
