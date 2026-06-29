import { NextRequest, NextResponse } from "next/server";
import { db, assets, identities } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { corsHeaders, corsOptions } from "@/src/lib/kernel/cors";
import { eq, and, sql } from "drizzle-orm";
import { rateLimit, getClientIP } from "@imajin/config";
import { createLogger } from "@imajin/logger";
import { createAsset, inferMime, isAllowedMime } from "@/src/lib/media/create-asset";

const log = createLogger("kernel");

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

const TIER_LIMITS: Record<string, number> = {
  soft: 50,
  preliminary: 50,
  established: 200,
};

function getUploadLimitBytes(identity: { tier?: string; uploadLimitMb?: number | null }): number {
  const mb = identity.uploadLimitMb ?? TIER_LIMITS[identity.tier || 'soft'] ?? 50;
  return mb * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// POST /api/assets — upload a file
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, "Retry-After": String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const ownerDid = resolveActingDid(identity);
  const uploadedBy = identity.id;

  // Fetch full identity row to get uploadLimitMb
  const [identityRow] = await db
    .select({ tier: identities.tier, uploadLimitMb: identities.uploadLimitMb })
    .from(identities)
    .where(eq(identities.id, identity.id))
    .limit(1);
  const uploadLimitBytes = getUploadLimitBytes(identityRow ?? { tier: identity.tier });

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  // Size check
  const limitMb = Math.round(uploadLimitBytes / (1024 * 1024));
  if (file.size > uploadLimitBytes) {
    return NextResponse.json(
      { error: `File exceeds ${limitMb} MB limit` },
      { status: 413 }
    );
  }

  // Extract original filename first (needed for MIME inference)
  let originalName =
    (formData.get("filename") as string | null) ??
    file.name ??
    "upload";

  // Rename generic audio filenames to a timestamped format (e.g. blob.webm → Audio_2026_01_01_12_00_00.webm)
  const GENERIC_AUDIO_PATTERN = /^(voice|blob|audio|recording|sound)\./i;
  if (file.type.startsWith("audio/") && GENERIC_AUDIO_PATTERN.test(originalName)) {
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ext = originalName.includes(".") ? originalName.slice(originalName.lastIndexOf(".")) : "";
    originalName = `Audio_${ts.getFullYear()}_${pad(ts.getMonth() + 1)}_${pad(ts.getDate())}_${pad(ts.getHours())}_${pad(ts.getMinutes())}_${pad(ts.getSeconds())}${ext}`;
  }

  // MIME check — infer from extension if browser sent octet-stream
  const mimeType = inferMime(file.type, originalName);
  if (!isAllowedMime(mimeType)) {
    return NextResponse.json(
      { error: `MIME type ${mimeType} is not allowed` },
      { status: 415 }
    );
  }

  // Parse optional context (for auto-folder assignment + access override)
  let context: { app?: string; feature?: string; entityId?: string; access?: string } | null = null;
  const contextRaw = formData.get("context");
  if (contextRaw && typeof contextRaw === "string") {
    try { context = JSON.parse(contextRaw); } catch { /* ignore bad JSON */ }
  }

  // Read file bytes and hand off to the shared create pipeline (#1170). The
  // route owns HTTP concerns (auth, multipart, tier/size, MIME inference);
  // createAsset owns hashing/CID, dedup, storage, .fair signing, DB insert,
  // DFOS anchor, auto-folder, and classification.
  const buffer = Buffer.from(await file.arrayBuffer());
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || new URL(request.url).origin;

  let result;
  try {
    result = await createAsset({
      ownerDid,
      uploadedBy,
      buffer,
      filename: originalName,
      mimeType,
      context,
      baseUrl,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Asset creation failed");
    return NextResponse.json(
      { error: "Storage failure", detail: String(err) },
      { status: 500, headers: cors }
    );
  }

  const { asset, deduplicated } = result;
  const url = `${baseUrl}/media/api/assets/${asset.id}`;

  if (deduplicated) {
    // Existing asset returned on content match (CID-global or hash+owner).
    return NextResponse.json(
      {
        id: asset.id,
        url,
        filename: asset.filename,
        mimeType: asset.mimeType,
        size: asset.size,
        hash: asset.hash,
        ...(asset.cid ? { cid: asset.cid } : {}),
        deduplicated: true,
      },
      { status: 200, headers: cors }
    );
  }

  return NextResponse.json(
    {
      id: asset.id,
      url,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      hash: asset.hash,
      storagePath: asset.storagePath,
      fairManifest: asset.fairManifest,
      createdAt: asset.createdAt,
    },
    { status: 201, headers: cors }
  );
}

// ---------------------------------------------------------------------------
// GET /api/assets — list assets for authenticated user (or via internal API key)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  // Internal API key auth: Bearer token + X-Owner-DID header
  const internalApiKey = process.env.MEDIA_INTERNAL_API_KEY;
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const { searchParams } = new URL(request.url);
  let ownerDid: string;
  let isAgentQuery = false;
  if (bearerToken && internalApiKey && bearerToken === internalApiKey) {
    const ownerDidHeader = request.headers.get("X-Owner-DID");
    if (!ownerDidHeader) {
      return NextResponse.json({ error: "X-Owner-DID header required" }, { status: 400, headers: cors });
    }
    ownerDid = ownerDidHeader;
  } else {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
    }
    const { identity } = authResult;
    const didParam = searchParams.get("did");

    if (didParam && didParam !== identity.id) {
      // Querying another DID's public assets — allowed for any authenticated user
      ownerDid = didParam;
      isAgentQuery = true;
    } else {
      ownerDid = resolveActingDid(identity);
    }
  }

  const search = searchParams.get("search");      // filename search
  const type = searchParams.get("type");          // e.g. "image"
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(Number.parseInt(searchParams.get("limit") || "50", 10), 200);
  const offset = Number.parseInt(searchParams.get("offset") || "0", 10);

  try {
    const { desc: drizzleDesc, asc: drizzleAsc } = await import("drizzle-orm");

    // Build where conditions
    const conditions = [eq(assets.ownerDid, ownerDid), eq(assets.status, "active")];

    // If querying another DID's assets, restrict to public ones
    if (isAgentQuery) {
      // Public = fairManifest->access->>type = 'public' OR no access restriction set
      conditions.push(
        sql`COALESCE((${assets.fairManifest}->'access'->>'type'), 'private') = 'public'`
      );
    }

    let rows = await db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(
        order === "asc"
          ? drizzleAsc(assets.createdAt)
          : drizzleDesc(assets.createdAt)
      )
      .limit(limit)
      .offset(offset);

    // Post-filter by MIME prefix
    if (type) {
      rows = rows.filter((r) => r.mimeType.startsWith(`${type}/`));
    }

    // Post-filter by filename search
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.filename.toLowerCase().includes(q));
    }

    return NextResponse.json({ assets: rows, limit, offset, count: rows.length }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, "DB query failed");
    return NextResponse.json(
      { error: "Database failure", detail: String(err) },
      { status: 500, headers: cors }
    );
  }
}
