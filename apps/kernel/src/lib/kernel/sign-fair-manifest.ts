import type { FairManifestV1_1 } from "@imajin/fair";
import { signManifest, isFairManifestV1_1 } from "@imajin/fair";
import { getNodeDid } from "./node-identity";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

/**
 * Result of an attempted node-signing pass.
 *   - ok=true   → manifest is signed (`signed` populated)
 *   - ok=false  → caller decides whether to fall back, surface error, etc.
 */
export type SignFairResult =
  | { ok: true; signed: FairManifestV1_1 }
  | { ok: false; error: string; status: number };

/**
 * Sign a v1.1 .fair manifest with this node's key.
 *
 * Used by:
 *   - upgrade-fair (v1.0 → v1.1 migration)
 *   - PUT /fair    (owner edits to a v1.1 manifest)
 *
 * Both paths rely on AUTH_PRIVATE_KEY in env. The node holds the only key
 * authorized to sign on behalf of the owner; the owner's edits are accepted
 * because the PUT endpoint authenticates them as the asset owner first.
 *
 * Accepts either 32-byte raw Ed25519 seed (64 hex chars) or PKCS8 DER (96
 * hex chars). Returns 500-shaped failures for missing/malformed keys so the
 * caller can short-circuit with NextResponse.json.
 */
export async function signFairAsNode(
  manifest: FairManifestV1_1,
): Promise<SignFairResult> {
  const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
  if (!privateKeyHex) {
    log.error({}, "AUTH_PRIVATE_KEY not configured — cannot sign manifest");
    return { ok: false, error: "Signing key not available", status: 500 };
  }

  const keyBuf = Buffer.from(privateKeyHex, "hex");
  let seedBytes: Uint8Array;
  if (keyBuf.length === 32) {
    seedBytes = new Uint8Array(keyBuf);
  } else if (keyBuf.length === 48) {
    // PKCS8 DER: last 32 bytes are the seed.
    seedBytes = new Uint8Array(keyBuf.subarray(16));
  } else {
    log.error(
      { len: keyBuf.length },
      "AUTH_PRIVATE_KEY wrong length (expected 32 or 48 bytes)",
    );
    return { ok: false, error: "Signing key has wrong length", status: 500 };
  }

  const nodeDid = await getNodeDid();

  try {
    // Strip any existing signature so we re-sign over current content.
    const stripped = { ...manifest } as FairManifestV1_1 & {
      signature?: unknown;
    };
    delete stripped.signature;
    const signed = await signManifest(stripped, {
      did: nodeDid,
      privateKey: seedBytes,
    });
    return { ok: true, signed: signed as FairManifestV1_1 };
  } catch (err) {
    log.error({ err: String(err) }, "Failed to sign manifest");
    return { ok: false, error: "Signing failed", status: 500 };
  }
}

/** Re-export for callers that need to gate on v1.1-ness before signing. */
export { isFairManifestV1_1 };
