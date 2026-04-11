import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db, folders } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { withLogger } from "@imajin/logger";

const DEFAULT_FOLDERS = [
  { name: "Photos", icon: "📷" },
  { name: "Audio", icon: "🎵" },
  { name: "Videos", icon: "🎬" },
  { name: "Documents", icon: "📄" },
  { name: "Uncategorized", icon: "📁" },
];

// ---------------------------------------------------------------------------
// POST /api/folders/init — create default system folders (idempotent)
// ---------------------------------------------------------------------------
export const POST = withLogger('kernel', async (request, { log }) => {
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const ownerDid = authResult.identity.actingAs || authResult.identity.id;

  // Check if any folders already exist for this user
  const existing = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.ownerDid, ownerDid))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json({ message: "Already initialized", created: [] });
  }

  try {
    const values = DEFAULT_FOLDERS.map((f, i) => ({
      id: `folder_${nanoid(16)}`,
      ownerDid,
      name: f.name,
      icon: f.icon,
      isSystem: true,
      sortOrder: i,
      parentId: null,
    }));

    const created = await db.insert(folders).values(values).returning();
    return NextResponse.json({ message: "Initialized", created }, { status: 201 });
  } catch (err) {
    log.error({ err: String(err) }, "DB insert failed");
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
});
