import { db, attestations } from "@/src/db";
import { canonicalize, crypto as authCrypto } from "@imajin/auth";
import type { AttestationType } from "@imajin/auth";

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

export async function emitSessionAttestation(params: {
  did: string;
  method: "keypair" | "magic_link" | "email_soft" | "email_onboard";
  tier: string;
  userAgent?: string | null;
}): Promise<void> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("Session attestation skipped: AUTH_PRIVATE_KEY not set");
    return;
  }

  const platformDid = process.env.PLATFORM_DID;
  if (!platformDid) {
    console.warn("Session attestation skipped: PLATFORM_DID not set");
    return;
  }

  const issuedAtMs = Date.now();
  const payload = {
    method: params.method,
    tier: params.tier,
    user_agent_class: classifyUserAgent(params.userAgent),
  };

  const canonicalPayload = canonicalize({
    subject_did: params.did,
    type: "session.created",
    context_id: null,
    context_type: "auth",
    payload,
    issued_at: issuedAtMs,
  });

  try {
    const signature = authCrypto.signSync(canonicalPayload, privateKey);
    await db.insert(attestations).values({
      id: genId("att"),
      issuerDid: platformDid,
      subjectDid: params.did,
      type: "session.created" as AttestationType,
      contextId: null,
      contextType: "auth",
      payload,
      signature,
      issuedAt: new Date(issuedAtMs),
    });
  } catch (err) {
    console.error("Session attestation error:", err);
  }
}

function classifyUserAgent(ua?: string | null): string {
  if (!ua) return "unknown";
  if (/mobile|android|iphone|ipad/i.test(ua)) return "mobile";
  if (/bot|crawler|spider/i.test(ua)) return "bot";
  return "desktop";
}
