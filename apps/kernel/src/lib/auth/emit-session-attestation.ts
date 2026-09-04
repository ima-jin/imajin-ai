import type { AttestationType } from "@imajin/auth";
import { emitMechanicalAttestation } from "./emit-mechanical-attestation";

const ATTESTATION_TYPE: AttestationType = "session.created";

/**
 * Emit a signed `session.created` attestation (#1822) on every session
 * start. Delegates the signing/insert mechanics to
 * `emitMechanicalAttestation`, shared with `emitDeviceAttestation` (#306).
 */
export async function emitSessionAttestation(params: {
  did: string;
  method: "keypair" | "magic_link" | "email_soft" | "email_onboard";
  tier: string;
  userAgent?: string | null;
}): Promise<void> {
  await emitMechanicalAttestation({
    subjectDid: params.did,
    type: ATTESTATION_TYPE,
    contextId: null,
    contextType: "auth",
    payload: {
      method: params.method,
      tier: params.tier,
      user_agent_class: classifyUserAgent(params.userAgent),
    },
  });
}

function classifyUserAgent(ua?: string | null): string {
  if (!ua) return "unknown";
  if (/mobile|android|iphone|ipad/i.test(ua)) return "mobile";
  if (/bot|crawler|spider/i.test(ua)) return "bot";
  return "desktop";
}
