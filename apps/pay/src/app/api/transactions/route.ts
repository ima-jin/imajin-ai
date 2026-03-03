import { NextRequest, NextResponse } from "next/server";
import { eq, or, desc } from "drizzle-orm";
import { db, transactions } from "../../../db";
import { corsHeaders } from "../../../lib/cors";

export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get("did");
  if (!did) {
    return NextResponse.json({ error: "Missing ?did= parameter" }, { status: 400, headers: corsHeaders(request) });
  }

  try {
    const rows = await db
      .select()
      .from(transactions)
      .where(or(eq(transactions.fromDid, did), eq(transactions.toDid, did)))
      .orderBy(desc(transactions.createdAt))
      .limit(50);
    return NextResponse.json({ transactions: rows }, { headers: corsHeaders(request) });
  } catch (err) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders(request) });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
