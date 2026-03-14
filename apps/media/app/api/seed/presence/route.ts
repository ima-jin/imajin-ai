/**
 * POST /api/seed/presence
 *
 * Internal endpoint: seeds a .imajin/ folder with default presence files.
 * Called by profile service on registration and inference toggle.
 * Authenticated via Bearer token (MEDIA_INTERNAL_API_KEY).
 * Idempotent — safe to call multiple times.
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { db, assets, folders, assetFolders } from "@/src/db";
import { eq, and } from "drizzle-orm";

const MEDIA_ROOT = process.env.MEDIA_ROOT || "/mnt/media";

function didToPath(did: string): string {
  return did.replace(/:/g, "_").replace(/[^a-zA-Z0-9._@-]/g, "_");
}

interface SeedFile {
  filename: string;
  content: string;
  mimeType: string;
}

function getDefaultFiles(handle?: string): SeedFile[] {
  const who = handle || "your";
  return [
    {
      filename: "soul.md",
      mimeType: "text/markdown",
      content: `# I'm ${who}'s presence

Edit this file to define who I am, how I speak, and what I care about.

## Personality

<!-- What's my tone? Formal? Casual? Playful? Direct? -->

## Boundaries

<!-- What topics should I avoid? What should I never do? -->
`,
    },
    {
      filename: "context.md",
      mimeType: "text/markdown",
      content: `# Knowledge & Interests

What topics should I know about? What's my expertise?

## Expertise

<!-- List areas of knowledge, skills, professional background -->

## Interests

<!-- What do I care about? What should I follow? -->

## Sources

<!-- Links, documents, or references I should draw from -->
`,
    },
    {
      filename: "config.json",
      mimeType: "application/json",
      content: JSON.stringify(
        {
          model: "default",
          temperature: 0.7,
          maxTokens: 2048,
        },
        null,
        2
      ),
    },
  ];
}

export async function POST(request: NextRequest) {
  // Internal API key auth
  const apiKey = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const expectedKey = process.env.MEDIA_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { did?: string; handle?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { did, handle } = body;
  if (!did || typeof did !== "string") {
    return NextResponse.json({ error: "did is required" }, { status: 400 });
  }

  // Check if .imajin folder already exists for this DID
  const existing = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerDid, did),
        eq(folders.name, ".imajin"),
        eq(folders.isSystem, true)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Already seeded — return existing state
    const folder = existing[0];
    const existingAssets = await db
      .select({ assetId: assetFolders.assetId })
      .from(assetFolders)
      .where(eq(assetFolders.folderId, folder.id));

    return NextResponse.json({
      message: "Already seeded",
      folderId: folder.id,
      assetIds: existingAssets.map((a) => a.assetId),
    });
  }

  // Create .imajin folder
  const folderId = `folder_${nanoid(16)}`;

  try {
    await db.insert(folders).values({
      id: folderId,
      ownerDid: did,
      name: ".imajin",
      icon: "🟠",
      isSystem: true,
      sortOrder: -1, // Sort before user folders
    });
  } catch (err) {
    console.error("[Presence] Folder creation failed:", err);
    return NextResponse.json(
      { error: "Failed to create folder" },
      { status: 500 }
    );
  }

  // Seed default files
  const didPath = didToPath(did);
  const dirPath = `${MEDIA_ROOT}/${didPath}/assets`;
  const seedFiles = getDefaultFiles(handle);
  const assetIds: string[] = [];

  try {
    await mkdir(dirPath, { recursive: true });

    for (const file of seedFiles) {
      const assetId = `asset_${nanoid(16)}`;
      const buffer = Buffer.from(file.content, "utf-8");
      const hash = createHash("sha256").update(buffer).digest("hex");
      const storagePath = `${dirPath}/${assetId}_${file.filename}`;
      const fairPath = `${dirPath}/${assetId}.fair.json`;

      const fairManifest = {
        fair: "1.0",
        id: assetId,
        type: file.mimeType,
        owner: did,
        created: new Date().toISOString(),
        source: "presence-seed",
        access: { type: "private" },
        attribution: [{ did, role: "creator", share: 1.0 }],
        transfer: { allowed: false },
      };

      // Write file + .fair sidecar to disk
      await writeFile(storagePath, buffer);
      await writeFile(fairPath, JSON.stringify(fairManifest, null, 2));

      // Insert asset record
      await db.insert(assets).values({
        id: assetId,
        ownerDid: did,
        filename: file.filename,
        mimeType: file.mimeType,
        size: buffer.length,
        storagePath,
        hash,
        fairManifest,
        fairPath,
        status: "active",
        metadata: { context: { app: "presence", feature: "seed" } },
      });

      // Link to .imajin folder
      await db
        .insert(assetFolders)
        .values({ assetId, folderId })
        .onConflictDoNothing();

      assetIds.push(assetId);
    }
  } catch (err) {
    console.error("[Presence] File seeding failed:", err);
    return NextResponse.json(
      { error: "Failed to seed files", detail: String(err) },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      message: "Presence seeded",
      folderId,
      assetIds,
      files: seedFiles.map((f) => f.filename),
    },
    { status: 201 }
  );
}
