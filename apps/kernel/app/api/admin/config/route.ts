import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) return null;

  const [nodeRow] = await sql`
    SELECT group_did FROM auth.group_identities
    WHERE group_did = ${session.actingAs}
    AND scope = 'node'
    LIMIT 1
  `;
  return nodeRow ? session : null;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [relayConfig] = await sql`
    SELECT did, imajin_did, node_fee_bps, buyer_credit_bps, created_at
    FROM relay.relay_config
    WHERE id = 'singleton'
    LIMIT 1
  `;

  const nodeConfigRows = await sql`
    SELECT key, value FROM registry.node_config
  `;

  const nodeConfig: Record<string, unknown> = {};
  for (const row of nodeConfigRows) {
    nodeConfig[row.key as string] = row.value;
  }

  return NextResponse.json({ relayConfig, nodeConfig });
}

export async function PUT(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 });
  }

  const { key, value } = body;

  await sql`
    INSERT INTO registry.node_config (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW()
  `;

  return NextResponse.json({ ok: true });
}
