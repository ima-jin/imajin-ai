import type { FairManifestV1_1 } from "@imajin/fair";
import { signFairAsNode } from "@/src/lib/kernel/sign-fair-manifest";

/**
 * ContentSigner — abstraction for .fair manifest signing operations.
 *
 * Exists to keep kernel-signing details out of every route handler and to
 * provide a stable swap point for future signing implementations without
 * touching asset identity, content chains, or any other Layer A concerns.
 *
 * Current implementations:
 *   KernelDelegatedSigner  — default; node holds the signing key (ships now)
 *   DeviceSigner           — future (#734); user's device holds the Ed25519
 *                            key; kernel becomes relay + UX only
 *
 * ─── Sovereignty tradeoff (do not silently weld shut) ────────────────────────
 * Kernel-delegated signing means the platform server holds signing authority
 * on behalf of each owner. This is weaker than "key never left the device"
 * (the DFOS-native trust model), but acceptable now because users have no
 * sovereign key store until the native app ships (#734).
 *
 * Migration is lossless: a DFOS content chain is a chain regardless of which
 * signer produced each revision. Swapping the signer requires no schema or
 * identity change — only a `ContentSigner` implementation swap. (#1121 §4)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface ContentSigner {
  /**
   * Sign a v1.1 .fair manifest on behalf of the asset owner.
   * Strips any existing signature before re-signing so the result is always
   * fresh. Throws if signing fails — callers should decide whether to treat
   * that as fatal or non-fatal based on context.
   */
  sign(manifest: FairManifestV1_1): Promise<FairManifestV1_1>;
}

/**
 * Default `ContentSigner` implementation.
 *
 * Uses the kernel node's Ed25519 key (`AUTH_PRIVATE_KEY` env var) to sign
 * manifests on behalf of the asset owner via `signFairAsNode`. The node acts
 * as a delegated signer — the owner has authenticated via `requireAuth` before
 * any call that uses this signer.
 *
 * See the sovereignty tradeoff note on `ContentSigner` above.
 */
export class KernelDelegatedSigner implements ContentSigner {
  async sign(manifest: FairManifestV1_1): Promise<FairManifestV1_1> {
    const result = await signFairAsNode(manifest);
    if (!result.ok) {
      throw new Error(`ContentSigner (kernel-delegated) failed: ${result.error}`);
    }
    return result.signed;
  }
}

/**
 * Process-lifetime singleton.
 * Import `contentSigner` rather than constructing per-request instances.
 * Swap the implementation here (or via dependency injection in tests) to
 * change signing behaviour globally without touching route handlers.
 */
export const contentSigner: ContentSigner = new KernelDelegatedSigner();
