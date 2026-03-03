import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, balances } from "../../../../db";
import { corsHeaders } from "../../../../lib/cors";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const decoded = decodeURIComponent(did);

  try {
    const [row] = await db.select().from(balances).where(eq(balances.did, decoded)).limit(1);
    const data = row
      ? { did: row.did, amount: row.amount, currency: row.currency }
      : { did: decoded, amount: "0", currency: "USD" };
    return NextResponse.json(data, { headers: corsHeaders(request) });
  } catch (err) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders(request) });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
