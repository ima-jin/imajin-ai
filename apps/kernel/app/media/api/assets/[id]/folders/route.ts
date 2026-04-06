import { NextRequest, NextResponse } from "next/server";
import { db, assets, folders, assetFolders } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq, and, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// PUT /api/assets/[id]/folders — set folder assignments (replaces all)
// ---------------------------------------------------------------------------
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.actingAs || authResult.identity.id;

  // Verify asset belongs to the authenticated user
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.ownerDid, ownerDid)))
    .limit(1);

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  let body: { folderIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { folderIds } = body;
  if (!Array.isArray(folderIds)) {
    return NextResponse.json({ error: "folderIds must be an array" }, { status: 400 });
  }
  if (!folderIds.every((f) => typeof f === "string")) {
    return NextResponse.json({ error: "folderIds must be an array of strings" }, { status: 400 });
  }

  // Validate all folders belong to the same owner
  if (folderIds.length > 0) {
    const found = await db
      .select()
      .from(folders)
      .where(and(inArray(folders.id, folderIds as string[]), eq(folders.ownerDid, ownerDid)));

    if (found.length !== folderIds.length) {
      return NextResponse.json({ error: "One or more folders not found or unauthorized" }, { status: 404 });
    }
  }

  try {
    // Replace all assignments in a transaction
    await db.transaction(async (tx) => {
      await tx.delete(assetFolders).where(eq(assetFolders.assetId, id));
      if ((folderIds as string[]).length > 0) {
        await tx.insert(assetFolders).values(
          (folderIds as string[]).map((folderId) => ({ assetId: id, folderId }))
        );
      }
    });

    // Update the direct folderId column too (UI reads this for filtering)
    await db.update(assets).set({ folderId: folderIds.length > 0 ? (folderIds as string[])[0] : null }).where(eq(assets.id, id));

    return NextResponse.json({ assetId: id, folderIds });
  } catch (err) {
    console.error("DB transaction failed:", err);
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
}
