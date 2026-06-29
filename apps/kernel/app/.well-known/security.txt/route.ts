import { NextResponse } from "next/server";

/**
 * /.well-known/security.txt — RFC 9116 vulnerability disclosure discovery.
 *
 * The standard file every security researcher (and most automated scanners)
 * checks first when they want to report an issue. Generated dynamically from
 * NEXT_PUBLIC_DOMAIN so each node in the federated network serves its own,
 * pointing reporters at this node's operator and policy.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc9116
 */

const SECURITY_EMAIL = process.env.SECURITY_CONTACT_EMAIL || "ryan@imajin.ai";
const POLICY_URL =
  process.env.SECURITY_POLICY_URL ||
  "https://github.com/ima-jin/imajin-ai/blob/main/SECURITY.md";

/** security.txt requires a future Expires date (RFC 9116 §2.5.5). Roll forward ~1 year from request time. */
function expiresOneYearOut(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  );
  return next.toISOString();
}

export function GET() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";
  const protocol = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "https://";
  const canonical = `${protocol}${domain}/.well-known/security.txt`;

  const lines = [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expiresOneYearOut()}`,
    `Policy: ${POLICY_URL}`,
    `Preferred-Languages: en`,
    `Canonical: ${canonical}`,
    "",
    "# Please include \"SECURITY\" in the subject line.",
    "# Request a PGP key in your first message if you need to share sensitive details.",
    "# Imajin is pre-1.0, single-operator software. See the Policy link for scope,",
    "# response targets, and an honest list of known limitations.",
    "",
  ];

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
