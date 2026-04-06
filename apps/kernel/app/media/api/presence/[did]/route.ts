import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { db, assets, folders, assetFolders } from "@/src/db";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

function requireInternalAuth(request: NextRequest): boolean {
  const apiKey = request.headers.get("authorization")?.replace("Bearer ", "");
  const expectedKey = process.env.MEDIA_INTERNAL_API_KEY;
  return !!(expectedKey && apiKey === expectedKey);
}

// ---------------------------------------------------------------------------
// GET /api/presence/[did] — read .imajin folder contents for a DID
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  if (!requireInternalAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { did } = params;
  if (!did) {
    return NextResponse.json({ error: "did is required" }, { status: 400 });
  }

  // Find .imajin folder for this DID
  const folder = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerDid, did), eq(folders.name, ".imajin"), eq(folders.isSystem, true)))
    .limit(1);

  if (folder.length === 0) {
    return NextResponse.json(
      { did, soul: null, context: null, config: null, seeded: false },
      { status: 200 }
    );
  }

  // Get assets linked to this folder
  const linkedAssets = await db
    .select({ asset: assets })
    .from(assetFolders)
    .innerJoin(assets, eq(assets.id, assetFolders.assetId))
    .where(eq(assetFolders.folderId, folder[0].id));

  const assetMap = Object.fromEntries(
    linkedAssets.map(({ asset }) => [asset.filename, asset])
  );

  async function readAssetText(filename: string): Promise<string | null> {
    const asset = assetMap[filename];
    if (!asset?.storagePath) return null;
    try {
      return await readFile(asset.storagePath, "utf8");
    } catch {
      return null;
    }
  }

  const [soulText, contextText, configText] = await Promise.all([
    readAssetText("soul.md"),
    readAssetText("context.md"),
    readAssetText("config.json"),
  ]);

  let config: object | null = null;
  if (configText) {
    try {
      config = JSON.parse(configText);
    } catch {
      config = null;
    }
  }

  return NextResponse.json({
    did,
    soul: soulText,
    context: contextText,
    config,
    seeded: true,
  });
}
