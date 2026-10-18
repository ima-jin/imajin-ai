import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { gateOperator } from '@/src/lib/jin/spend-route-gate';
import { sessionCommandTypeSchema } from '@/src/lib/jin/session-command-contract';
import { prepareSessionCommand, dispatchSessionCommand, SessionCommandError } from '@/src/lib/jin/session-commands';

export const dynamic = 'force-dynamic';
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), type: sessionCommandTypeSchema, payload: z.unknown() }).strict(),
  z.object({ action: z.literal('dispatch'), command: z.unknown() }).strict(),
]);

export async function POST(request: NextRequest, props: { params: Promise<{ loopId: string }> }) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const gate = await gateOperator(request, headers, {});
  if ('response' in gate) return gate.response;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 32 * 1024) {
      return NextResponse.json({ error: 'Command too large' }, { status: 413, headers });
    }
    const body = requestSchema.parse(JSON.parse(raw));
    const { loopId } = await props.params;
    const result = body.action === 'prepare'
      ? { command: await prepareSessionCommand(loopId, gate.operatorDid, body.type, body.payload) }
      : await dispatchSessionCommand(loopId, gate.operatorDid, body.command);
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof SessionCommandError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    return NextResponse.json({ error: invalid ? 'Invalid command' : 'Command unavailable' }, { status: invalid ? 400 : 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
