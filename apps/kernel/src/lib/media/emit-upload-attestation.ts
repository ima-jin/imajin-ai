import { emitAttestation } from "@imajin/auth";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

/**
 * Node-witnessed upload provenance, never a claim signed by the uploader.
 * The owner is the acting principal; uploadedBy is the authenticated actor.
 * The digest binds the upload-time attribution even if the .fair URL changes.
 */
export function emitUploadAttestation(params: {
  assetId: string;
  ownerDid: string;
  uploadedBy: string;
  manifestUrl: string;
  manifestDigest: string;
  contentHash: string;
}): void {
  const issuerDid = process.env.PLATFORM_DID;
  if (!issuerDid) {
    log.warn({ assetId: params.assetId }, "media.uploaded skipped: PLATFORM_DID not set");
    return;
  }

  // Defer invocation as well as delivery: synchronous throws and rejected or
  // indefinitely pending emitters must never fail or hold up the upload.
  void Promise.resolve().then(() => emitAttestation({
    issuer_did: issuerDid,
    subject_did: `did:imajin:${params.assetId}`,
    type: "media.uploaded",
    context_id: params.assetId,
    context_type: "media",
    payload: {
      asset_did: `did:imajin:${params.assetId}`,
      uploader_did: params.uploadedBy,
      owner_did: params.ownerDid,
      fair_manifest_ref: params.manifestUrl,
      fair_manifest_digest: `sha256:${params.manifestDigest}`,
      content_hash: params.contentHash,
    },
  })).catch((err: unknown) => {
    log.error({ err: String(err), assetId: params.assetId }, "media.uploaded attestation failed (non-fatal)");
  });
}
