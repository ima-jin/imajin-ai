import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db, folders } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { withLogger } from "@imajin/logger";

export const dynamic = "force-dynamic";

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
  const ownerDid = authResult.identity.actingFor || authResult.identity.actingAs || authResult.identity.id;

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

    // ON CONFLICT DO NOTHING makes this idempotent even under concurrent requests.
    const created = await db
      .insert(folders)
      .values(values)
      .onConflictDoNothing()
      .returning();

    return NextResponse.json(
      { message: created.length > 0 ? "Initialized" : "Already initialized", created },
      { status: created.length > 0 ? 201 : 200 }
    );
  } catch (err) {
    log.error({ err: String(err) }, "DB insert failed");
    return NextResponse.json({ error: "Database failure", detail: String(err) }, { status: 500 });
  }
});
