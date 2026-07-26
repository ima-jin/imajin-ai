/**
 * GET /media/api/lots/[correlationId]/fair
 *
 * Public .fair settlement read route (#1440).
 *
 * Returns the disclosure-gate-evaluated .fair manifest for a supply lot,
 * keyed by its correlationId. The route itself decides nothing about what
 * to show — disclosure is a layered stack of signed predicates:
 *
 *   • Floor fields (id, type, created, fair, integrity, signature,
 *     platformSignature) — ALWAYS in the response; public record asserts
 *     "a real, signed settlement of type X occurred at T — verify the sig."
 *
 *   • Community overlay — from nodeConfig key `fair.disclosure.overlay`
 *     (written by the deployment operator; defaults to
 *     DEFAULT_AGRIFORTRESS_OVERLAY if absent). The tier is data, not code.
 *
 *   • Subject gates — from `manifest._disclosure` (co-signed by the subject).
 *     Subject can tighten OR loosen the community default, but cannot remove
 *     floor fields.
 *
 *   • Caller consent — on-consent fields materialize only when there is an
 *     active kernel.consent_grants row granting the caller's DID (or '*')
 *     for purpose `fair.settlement.read`. Owner grants access → full view;
 *     no grant → redacted/attested view.
 *
 * Withheld on-consent fields are emitted in `_withheld` as:
 *   `{ "amount": { "present": true, "attestation": "covered-by-signature" } }`
 * so the consumer can verify the floor + signature independently without
 * seeing the sealed value. Full ZKP hardening is #1226.
 *
 * This route is the counterpart of apps/kernel/app/media/api/assets/[id]/fair/route.ts;
 * that route returns the manifest for an asset. This route returns the
 * settlement manifest for a lot, subject to the composable disclosure gates.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, supplyLots } from "@/src/db";
import { getClient } from "@imajin/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { createLogger } from "@imajin/logger";
import type { FairManifest } from "@imajin/fair";
import {
  DEFAULT_AGRIFORTRESS_OVERLAY,
  composeEffectivePolicy,
  applyDisclosureGates,
  parseSubjectGates,
  type FairDisclosureOverlay,
} from "@/src/lib/media/fair-disclosure-policy";

const log = createLogger("kernel");

/**
 * Purpose tag used in kernel.consent_grants lookups.
 * Owner writes a grant with this purpose to unlock on-consent fields for a
 * specific DID (or '*' wildcard). Same consent rail as the vault/connector
 * work (#1242) — consistent custody, no parallel disclosure engine.
 */
const FAIR_SETTLEMENT_READ_PURPOSE = "fair.settlement.read";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /media/api/lots/[correlationId]/fair
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ correlationId: string }> },
) {
  const { correlationId } = await params;

  // ── 1. Look up lot ───────────────────────────────────────────────────────
  let lot: typeof supplyLots.$inferSelect | undefined;
  try {
    [lot] = await db
      .select()
      .from(supplyLots)
      .where(eq(supplyLots.correlationId, correlationId))
      .limit(1);
  } catch (err) {
    log.error({ err: String(err), correlationId }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!lot) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rawManifest = lot.fairManifest;
  if (
    !rawManifest ||
    typeof rawManifest !== "object" ||
    Object.keys(rawManifest as object).length === 0
  ) {
    return NextResponse.json(
      { error: "No .fair manifest for this lot" },
      { status: 404 },
    );
  }

  const manifestRaw = rawManifest as Record<string, unknown>;

  // ── 2. Community overlay (nodeConfig > default) ──────────────────────────
  const communityOverlay = await loadCommunityOverlay();

  // ── 3. Subject gates (manifest._disclosure) ──────────────────────────────
  const subjectGates = parseSubjectGates(manifestRaw);

  // ── 4. Composed effective policy ─────────────────────────────────────────
  const policy = composeEffectivePolicy(communityOverlay, subjectGates);

  // ── 5. Optional auth — check consent grants for on-consent fields ────────
  //
  // This route is publicly accessible without auth (floor fields are always
  // returned). Auth is OPTIONAL: if the caller presents a Bearer token, we
  // resolve their DID and check for active consent grants that unlock
  // on-consent fields. If they lack a grant — or don't authenticate at all —
  // they get the redacted/attested view.
  let grantedFields = new Set<string>();
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const authResult = await requireAuth(request);
    if (!("error" in authResult)) {
      const requesterDid = resolveActingDid(authResult.identity);
      const ownerDid =
        typeof manifestRaw["owner"] === "string"
          ? manifestRaw["owner"]
          : lot.originatingDid;
      grantedFields = await queryConsentGrants(ownerDid, requesterDid);
    }
    // Auth header present but invalid → still serve the public view (no 401).
    // On-consent fields stay withheld. Only hard auth failures (missing header)
    // and consent-grant checks are surfaced this way.
  }

  // ── 6. Apply gates ───────────────────────────────────────────────────────
  const { manifest: disclosed, withheld } = applyDisclosureGates(
    manifestRaw as unknown as FairManifest,
    policy,
    grantedFields,
  );

  // ── 7. Build and return response ─────────────────────────────────────────
  const response: Record<string, unknown> = { ...disclosed };
  if (Object.keys(withheld).length > 0) {
    response["_withheld"] = withheld;
  }

  return NextResponse.json(response, {
    headers: {
      /**
       * Advertises the disclosure model. Consumers can use this to
       * distinguish a gate-evaluated response from a raw manifest dump.
       */
      "X-Fair-Disclosure": "layered",
      /**
       * Floor fields are deterministic across all callers; cache briefly.
       * The cache is invalidated naturally on the next PUT to nodeConfig or
       * lot manifest — both are infrequent writes.
       */
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the community disclosure overlay from nodeConfig key
 * `fair.disclosure.overlay`. Falls back to DEFAULT_AGRIFORTRESS_OVERLAY
 * if the key is absent or the DB call fails (non-fatal).
 *
 * Uses raw SQL via @imajin/db to avoid the Drizzle schema import and stay
 * consistent with the bus-package boundary rules (packages/bus/AGENTS.md).
 */
async function loadCommunityOverlay(): Promise<FairDisclosureOverlay> {
  try {
    const sql = getClient();
    const [row] = await sql`
      SELECT value
      FROM registry.node_config
      WHERE key = 'fair.disclosure.overlay'
      LIMIT 1
    `;
    if (row?.value && typeof row.value === "object" && !Array.isArray(row.value)) {
      return row.value as FairDisclosureOverlay;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "fair.disclosure.overlay load failed — using default");
  }
  return DEFAULT_AGRIFORTRESS_OVERLAY;
}

/**
 * Query kernel.consent_grants for active grants from `subjectDid` to
 * `requesterDid` (or wildcard '*') for purpose `fair.settlement.read`.
 *
 * Returns the union of allowed_fields across all matching grants, so a
 * subject can issue a narrow grant (just `amount`) or a broad grant (all
 * on-consent fields) and the route automatically applies whatever the
 * current active grants say.
 *
 * Uses raw SQL via @imajin/db — same pattern as packages/bus reactors.
 */
async function queryConsentGrants(
  subjectDid: string,
  requesterDid: string,
): Promise<Set<string>> {
  try {
    const sql = getClient();
    const rows = await sql`
      SELECT allowed_fields
      FROM kernel.consent_grants
      WHERE subject        = ${subjectDid}
        AND (granted_to    = ${requesterDid} OR granted_to = '*')
        AND purpose        = ${FAIR_SETTLEMENT_READ_PURPOSE}
        AND status         = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const fields = new Set<string>();
    for (const row of rows) {
      const allowed = row.allowed_fields as unknown;
      if (Array.isArray(allowed)) {
        for (const f of allowed) {
          if (typeof f === "string") fields.add(f);
        }
      }
    }
    return fields;
  } catch (err) {
    log.warn({ err: String(err), subjectDid, requesterDid }, "consent grant query failed — treating as no grants");
    return new Set();
  }
}
