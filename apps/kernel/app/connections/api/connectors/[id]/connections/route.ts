import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, googleWorkspaceState } from '@/src/db';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import {
  createConnectorConnection, listConnectorRegistrations, renameConnectorConnection,
} from '@/src/lib/kernel/connector-registry-store';
import { readActiveConnectorScopes } from '@/src/lib/kernel/scope-manifest-core';
import { connectionSlot, connectionVaultField } from '@/src/lib/kernel/connection-slots';
import { vaultFieldStatus, vaultFieldStatusForGrantee } from '@/src/lib/vault';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function headers(request: NextRequest) {
  return { ...corsHeaders(request), 'Cache-Control': 'no-store' };
}

async function authorize(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const connector = getConnector(id);
  if (!connector) return NextResponse.json({ error: 'Unknown connector' }, { status: 404, headers: headers(request) });
  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: headers(request) });
  return { connector, ownerDid: auth.ownerDid };
}

export async function GET(request: NextRequest, context: Context) {
  const auth = await authorize(request, context);
  if (auth instanceof NextResponse) return auth;
  const { connector, ownerDid } = auth;
  try {
    const rows = (await listConnectorRegistrations(ownerDid)).filter((row) => row.provider === connector.id);
    const slots = new Set(['primary', ...rows.map((row) => row.slot)]);
    const googleState = connector.id === 'google'
      ? await db.select().from(googleWorkspaceState).where(eq(googleWorkspaceState.ownerDid, ownerDid))
      : [];
    for (const row of googleState) slots.add(row.slot);
    const connections = await Promise.all([...slots].sort((a, b) => a.localeCompare(b, 'en')).map(async (slot) => {
      const registration = rows.find((row) => row.slot === slot);
      const state = googleState.find((row) => row.slot === slot);
      const scopes = await readActiveConnectorScopes(ownerDid, connector.channel, connector.connectorDid, slot);
      // Registry metadata is only a field-name projection, never authorization.
      // Consult custody without unsealing; a new slot has no field to borrow.
      const field = connector.ingestionPattern === 'oauth'
        ? connectionVaultField(`${connector.id}-oauth`, ownerDid, slot)
        : registration?.sealedKeyField;
      let status = 'absent';
      if (field) {
        status = connector.ingestionPattern === 'static-secret'
          ? await vaultFieldStatusForGrantee(field, connector.connectorDid)
          : await vaultFieldStatus(field);
      }
      const configStatus = connector.ingestionPattern === 'oauth'
        ? await vaultFieldStatus(connectionVaultField(`${connector.id}-config`, ownerDid, slot))
        : status;
      return {
        slot,
        label: registration?.label ?? slot,
        accountEmail: state?.accountEmail ?? state?.gmailEmailAddress ?? registration?.accountEmail ?? null,
        connected: connector.ingestionPattern === 'native' ? scopes.length > 0 : status === 'ready',
        configured: status === 'ready' || configStatus === 'ready' || configStatus === 'pending-grant',
        scopes,
      };
    }));
    return NextResponse.json({ connections }, { headers: headers(request) });
  } catch {
    return NextResponse.json({ error: 'Connections unavailable' }, { status: 500, headers: headers(request) });
  }
}

/** A label is presentation text, not a selector or authority. */
function readLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw new Error('label must contain 1–100 characters');
  }
  return value.trim();
}

function readSlot(value: unknown): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error('Invalid connection slot');
  }
  return connectionSlot(value);
}

async function mutate(request: NextRequest, context: Context, rename: boolean) {
  const auth = await authorize(request, context);
  if (auth instanceof NextResponse) return auth;
  let slot: string;
  let label: string | undefined;
  try {
    const body = await request.json() as { slot?: unknown; label?: unknown };
    const rawSlot = rename ? new URL(request.url).searchParams.get('slot') : body.slot;
    slot = readSlot(rawSlot);
    label = readLabel(body.label);
    if (rename && label === undefined) throw new Error('label is required');
  } catch {
    return NextResponse.json({ error: 'Invalid connection slot or label' }, { status: 400, headers: headers(request) });
  }
  try {
    const row = rename
      ? await renameConnectorConnection(auth.ownerDid, auth.connector.id, slot, label!)
      : await createConnectorConnection(auth.ownerDid, auth.connector.id, slot, label);
    if (!row) return NextResponse.json({ error: 'Connection not found' }, { status: 404, headers: headers(request) });
    return NextResponse.json({ slot: row.slot, label: row.label ?? row.slot }, {
      status: rename ? 200 : 201, headers: headers(request),
    });
  } catch (error) {
    const exists = error instanceof Error && error.message === 'connection_exists';
    return NextResponse.json({ error: exists ? 'Connection already exists' : 'Connection update failed' }, {
      status: exists ? 409 : 500, headers: headers(request),
    });
  }
}

export function POST(request: NextRequest, context: Context) { return mutate(request, context, false); }
export function PATCH(request: NextRequest, context: Context) { return mutate(request, context, true); }
