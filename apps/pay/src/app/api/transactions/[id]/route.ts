import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, transactions } from "../../../../db";
import { corsHeaders } from "../../../../lib/cors";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [row] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!row) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404, headers: corsHeaders(request) });
    }
    return NextResponse.json(row, { headers: corsHeaders(request) });
  } catch (err) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders(request) });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
