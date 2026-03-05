import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db, folders, assetFolders } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { eq, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// GET /api/folders — list all folders for authenticated user with asset counts
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.id;

  try {
    const rows = await db
      .select({
        id: folders.id,
        ownerDid: folders.ownerDid,
        name: folders.name,
        parentId: folders.parentId,
        icon: folders.icon,
        isSystem: folders.isSystem,
        sortOrder: folders.sortOrder,
        createdAt: folders.createdAt,
        assetCount: sql<number>`cast(count(${assetFolders.assetId}) as int)`,
      })
      .from(folders)
      .leftJoin(assetFolders, eq(assetFolders.folderId, folders.id))
      .where(eq(folders.ownerDid, ownerDid))
      .groupBy(folders.id)
      .orderBy(folders.sortOrder, folders.name);

    return NextResponse.json({ folders: rows });
  } catch (err) {
    console.error("DB query failed:", err);
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/folders — create a folder
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.id;

  let body: { name?: string; parentId?: string; icon?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, parentId, icon } = body;
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Validate parentId belongs to the same owner
  if (parentId) {
    const [parent] = await db.select().from(folders).where(eq(folders.id, parentId)).limit(1);
    if (!parent || parent.ownerDid !== ownerDid) {
      return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
    }
  }

  const id = `folder_${nanoid(16)}`;

  try {
    const [folder] = await db
      .insert(folders)
      .values({ id, ownerDid, name: name.trim(), parentId: parentId ?? null, icon: icon ?? null })
      .returning();

    return NextResponse.json(folder, { status: 201 });
  } catch (err) {
    console.error("DB insert failed:", err);
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
}
