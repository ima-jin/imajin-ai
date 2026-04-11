import { db, attestations } from "@/src/db";
import { canonicalize, crypto as authCrypto } from "@imajin/auth";
import type { AttestationType } from "@imajin/auth";
import { computeCid } from "@imajin/cid";
import { getNodeDid } from "@/src/lib/kernel/node-identity";
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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
    log.warn({}, 'session attestation skipped: AUTH_PRIVATE_KEY not set');
    return;
  }

  const platformDid = await getNodeDid();
  if (!platformDid) {
    log.warn({}, 'session attestation skipped: node DID not set');
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

    let cid: string | null = null;
    try {
      cid = await computeCid({
        issuerDid: platformDid,
        subjectDid: params.did,
        type: "session.created",
        contextId: null,
        contextType: "auth",
        payload,
        issuedAt: issuedAtMs,
      });
    } catch { /* non-fatal */ }

    await db.insert(attestations).values({
      id: genId("att"),
      issuerDid: platformDid,
      subjectDid: params.did,
      type: "session.created" as AttestationType,
      contextId: null,
      contextType: "auth",
      payload,
      signature,
      cid,
      issuedAt: new Date(issuedAtMs),
    });
  } catch (err) {
    log.error({ err: String(err) }, 'session attestation error');
  }
}

function classifyUserAgent(ua?: string | null): string {
  if (!ua) return "unknown";
  if (/mobile|android|iphone|ipad/i.test(ua)) return "mobile";
  if (/bot|crawler|spider/i.test(ua)) return "bot";
  return "desktop";
}
