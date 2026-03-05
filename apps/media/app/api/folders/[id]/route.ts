import { NextRequest, NextResponse } from "next/server";
import { db, folders } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { eq, and } from "drizzle-orm";

// ---------------------------------------------------------------------------
// PATCH /api/folders/[id] — rename, move, or change icon
// ---------------------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.id;

  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.ownerDid, ownerDid)))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  let body: { name?: string; parentId?: string | null; icon?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    updates.name = body.name.trim();
  }
  if (body.parentId !== undefined) {
    if (body.parentId !== null) {
      const [parent] = await db.select().from(folders).where(eq(folders.id, body.parentId)).limit(1);
      if (!parent || parent.ownerDid !== ownerDid) {
        return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
      }
      if (body.parentId === id) {
        return NextResponse.json({ error: "Folder cannot be its own parent" }, { status: 400 });
      }
    }
    updates.parentId = body.parentId;
  }
  if (body.icon !== undefined) {
    updates.icon = body.icon;
  }

  try {
    const [updated] = await db
      .update(folders)
      .set(updates)
      .where(and(eq(folders.id, id), eq(folders.ownerDid, ownerDid)))
      .returning();

    return NextResponse.json(updated);
  } catch (err) {
    console.error("DB update failed:", err);
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/folders/[id] — delete folder (assets stay, just unlinked)
// ---------------------------------------------------------------------------
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.id;

  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.ownerDid, ownerDid)))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }
  if (existing.isSystem) {
    return NextResponse.json({ error: "Cannot delete system folders" }, { status: 403 });
  }

  try {
    await db.delete(folders).where(and(eq(folders.id, id), eq(folders.ownerDid, ownerDid)));
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("DB delete failed:", err);
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
}
