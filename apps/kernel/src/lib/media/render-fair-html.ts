/**
 * render-fair-html.ts — Human-readable HTML view of a .fair manifest.
 *
 * Used by the GET /api/assets/[id]/fair route when the client sends
 * Accept: text/html (i.e. a browser). API consumers still get JSON.
 */
import type { FairManifest, FairManifestV1_1, FairFee, FairDistributionRight } from "@imajin/fair";
import { isFairManifestV1_1 } from "@imajin/fair";

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function truncDid(did: string | undefined): string {
  if (!did) return "—";
  if (did.length <= 28) return esc(did);
  return `<span title="${esc(did)}">${esc(did.slice(0, 16))}…${esc(did.slice(-8))}</span>`;
}

function formatMoney(amount: number, currency: string): string {
  if (currency === "MJNX") return `${(amount / 100).toFixed(2)} MJNx`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function distModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    allowed: "Allowed",
    "allow-with-attribution": "Allowed with attribution",
    "allow-with-share": "Allowed with revenue share",
    "quote-with-attribution": "Quote only (with attribution)",
    reserved: "All rights reserved",
  };
  return labels[mode] ?? mode;
}

function accessLabel(access: FairManifest["access"]): { label: string; color: string } {
  if (!access) return { label: "Private", color: "#ef4444" };
  if (access === "public") return { label: "Public", color: "#22c55e" };
  if (access === "private") return { label: "Private", color: "#ef4444" };
  switch (access.type) {
    case "public":
      return { label: "Public", color: "#22c55e" };
    case "private":
      return { label: "Private", color: "#ef4444" };
    case "trust-graph":
      return { label: "Trust Graph", color: "#f59e0b" };
    case "conversation":
      return { label: "Conversation", color: "#8b5cf6" };
    default:
      return { label: String(access.type), color: "#6b7280" };
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── Section builders ────────────────────────────────────────────────────────

function renderAttribution(manifest: FairManifest): string {
  const entries = manifest.attribution?.length
    ? manifest.attribution
    : ("chain" in manifest ? (manifest as FairManifestV1_1).chain ?? [] : []);

  if (!entries.length) return "";

  const rows = entries
    .map((e) => {
      const pct = (e.share * 100).toFixed(1);
      const barWidth = Math.max(Math.min(e.share * 100, 100), 0);
      return `
      <div class="entry">
        <div class="entry-header">
          <span class="role">${esc(e.role)}</span>
          <span class="did">${e.name ? esc(e.name) : truncDid(e.did)}</span>
          ${e.chainProof?.verified ? '<span class="verified">⛓ verified</span>' : ""}
        </div>
        <div class="share-bar">
          <div class="share-fill" style="width:${barWidth}%"></div>
        </div>
        <div class="share-pct">${pct}%</div>
        ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}
      </div>`;
    })
    .join("");

  return section("Attribution", rows);
}

function renderFees(fees: FairFee[]): string {
  if (!fees.length) return "";

  const totalBps = fees.reduce((s, f) => s + f.rateBps, 0);
  const rows = fees
    .map(
      (f) => `
      <div class="fee-row">
        <span class="fee-name">${esc(f.name)}</span>
        <span class="fee-role">${esc(f.role)}</span>
        <span class="fee-rate">${bpsToPercent(f.rateBps)}</span>
      </div>`
    )
    .join("");

  return section(
    "Fees",
    `${rows}
    <div class="fee-total">
      <span>Total</span>
      <span>${bpsToPercent(totalBps)}</span>
    </div>`
  );
}

function renderDistribution(dist: FairManifestV1_1["distribution"]): string {
  if (!dist) return "";

  const channels: [string, FairDistributionRight | undefined][] = [
    ["Reproduction", dist.reproduction],
    ["Streaming", dist.streaming],
    ["Derivative Works", dist.derivative],
    ["Syndication", dist.syndication],
  ];

  const rows = channels
    .filter(([, r]) => r)
    .map(([name, right]) => {
      const r = right!;
      let detail = distModeLabel(r.mode);
      if (r.price) detail += ` — ${formatMoney(r.price.amount, r.price.currency)}`;
      if (r.quote) {
        const parts: string[] = [];
        if (r.quote.maxPercent) parts.push(`max ${r.quote.maxPercent}%`);
        if (r.quote.maxWords) parts.push(`max ${r.quote.maxWords} words`);
        if (parts.length) detail += ` (${parts.join(", ")})`;
      }
      return `
      <div class="dist-row">
        <span class="dist-name">${esc(name)}</span>
        <span class="dist-mode">${esc(detail)}</span>
      </div>`;
    })
    .join("");

  return rows ? section("Distribution Rights", rows) : "";
}

function renderTransfer(transfer: FairManifest["transfer"]): string {
  if (!transfer) return "";

  const rows: string[] = [];
  rows.push(pill("Transfers", transfer.allowed ? "Allowed" : "Not allowed", transfer.allowed ? "#22c55e" : "#ef4444"));

  if (transfer.allowed) {
    if ("requiresAttribution" in transfer && transfer.requiresAttribution) {
      rows.push(pill("Attribution", "Required", "#f59e0b"));
    }
    if ("price" in transfer && transfer.price) {
      const p = transfer.price as { amount: number; currency: string };
      rows.push(pill("Price", formatMoney(p.amount, p.currency), "#3b82f6"));
    }
    if ("resaleRoyaltyBps" in transfer && transfer.resaleRoyaltyBps) {
      rows.push(pill("Resale Royalty", bpsToPercent(transfer.resaleRoyaltyBps), "#8b5cf6"));
    } else if (transfer.resaleRoyalty) {
      rows.push(pill("Resale Royalty", `${(transfer.resaleRoyalty * 100).toFixed(1)}%`, "#8b5cf6"));
    }
    if (transfer.refundable) rows.push(pill("Refundable", "Yes", "#22c55e"));
    if (transfer.faceValueCap) rows.push(pill("Face-value cap", "Enabled", "#f59e0b"));
  }

  return section("Transfer", `<div class="pills">${rows.join("")}</div>`);
}

function renderCommercial(commercial: FairManifestV1_1["commercial"]): string {
  if (!commercial) return "";
  const items: string[] = [];
  items.push(pill("Commercial Use", commercial.allowed ? "Allowed" : "Not allowed", commercial.allowed ? "#22c55e" : "#ef4444"));
  if (commercial.contactRequired) items.push(pill("Contact Required", "Yes", "#f59e0b"));
  return section("Commercial", `<div class="pills">${items.join("")}</div>`);
}

function renderTraining(training: FairManifestV1_1["training"]): string {
  if (!training) return "";
  const items: string[] = [];
  items.push(pill("AI Training", training.allowed ? "Allowed" : "Not allowed", training.allowed ? "#22c55e" : "#ef4444"));
  if (training.grants?.length) {
    for (const g of training.grants) {
      let label = g.purpose;
      if (g.scope) label += ` (${g.scope})`;
      if (g.expires) label += ` — expires ${formatDate(g.expires)}`;
      items.push(pill("Grant", label, "#3b82f6"));
    }
  }
  return section("AI Training", `<div class="pills">${items.join("")}</div>`);
}

function renderSignature(manifest: FairManifest): string {
  const sig = manifest.signature;
  if (!sig) return "";

  const sigAny = sig as unknown as Record<string, unknown>;
  const signer = (sigAny.signer ?? sigAny.publicKeyRef ?? "") as string;
  const signedAt = (sigAny.signedAt ?? undefined) as string | undefined;
  const algorithm = (sigAny.alg ?? sigAny.algorithm ?? "ed25519") as string;

  return section(
    "Signature",
    `<div class="sig">
      <div class="sig-row">
        <span class="sig-label">Algorithm</span>
        <span class="sig-value">${esc(algorithm)}</span>
      </div>
      <div class="sig-row">
        <span class="sig-label">Signer</span>
        <span class="sig-value did">${truncDid(signer)}</span>
      </div>
      ${signedAt ? `
      <div class="sig-row">
        <span class="sig-label">Signed</span>
        <span class="sig-value">${formatDate(signedAt)}</span>
      </div>` : ""}
      <div class="sig-row">
        <span class="sig-label">Value</span>
        <code class="sig-hash">${esc(sig.value?.slice(0, 32) ?? "")}…</code>
      </div>
    </div>`
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────

function section(title: string, body: string): string {
  return `
  <section>
    <h2>${esc(title)}</h2>
    ${body}
  </section>`;
}

function pill(label: string, value: string, color: string): string {
  return `<span class="pill"><span class="pill-dot" style="background:${color}"></span>${esc(label)}: <strong>${esc(value)}</strong></span>`;
}

// ── Main renderer ───────────────────────────────────────────────────────────

export function renderFairHtml(manifest: FairManifest, assetId: string, baseUrl: string): string {
  const v11 = isFairManifestV1_1(manifest);
  const { label: accessLbl, color: accessColor } = accessLabel(manifest.access);

  const sections: string[] = [];

  // Header info
  sections.push(`
  <header>
    <div class="header-top">
      <div class="fair-badge">.fair</div>
      <span class="version">v${esc(manifest.fair || (manifest as FairManifestV1_1).version || "1.0")}</span>
      <span class="access-badge" style="border-color:${accessColor};color:${accessColor}">${esc(accessLbl)}</span>
    </div>
    <div class="meta">
      <div class="meta-row">
        <span class="meta-label">Asset</span>
        <code class="meta-value">${esc(assetId)}</code>
      </div>
      <div class="meta-row">
        <span class="meta-label">Type</span>
        <span class="meta-value">${esc(manifest.type)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Owner</span>
        <span class="meta-value did">${truncDid(manifest.owner)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Created</span>
        <span class="meta-value">${formatDate(manifest.created)}</span>
      </div>
      ${manifest.source ? `
      <div class="meta-row">
        <span class="meta-label">Source</span>
        <span class="meta-value">${esc(manifest.source)}</span>
      </div>` : ""}
    </div>
  </header>`);

  // Attribution
  sections.push(renderAttribution(manifest));

  // Distribution rights (v1.1)
  if (v11) {
    sections.push(renderDistribution((manifest as FairManifestV1_1).distribution));
  }

  // Fees
  if (manifest.fees?.length) {
    sections.push(renderFees(manifest.fees));
  }

  // Transfer
  sections.push(renderTransfer(manifest.transfer));

  // Commercial (v1.1)
  if (v11) {
    sections.push(renderCommercial((manifest as FairManifestV1_1).commercial));
  }

  // Training (v1.1)
  if (v11) {
    sections.push(renderTraining((manifest as FairManifestV1_1).training));
  }

  // Tipping (v1.1)
  if (v11 && (manifest as FairManifestV1_1).tipping) {
    const tipping = (manifest as FairManifestV1_1).tipping!;
    sections.push(
      section("Tipping", `<div class="pills">${pill("Tipping", tipping.enabled ? "Enabled" : "Disabled", tipping.enabled ? "#22c55e" : "#6b7280")}</div>`)
    );
  }

  // Signature
  sections.push(renderSignature(manifest));

  const jsonUrl = `${baseUrl}/media/api/assets/${encodeURIComponent(assetId)}/fair`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>.fair manifest — ${esc(assetId)}</title>
  <meta name="description" content="Attribution and distribution rights for ${esc(assetId)}">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      line-height: 1.6;
      padding: 2rem 1rem;
      min-height: 100vh;
    }

    .container {
      max-width: 640px;
      margin: 0 auto;
    }

    header {
      margin-bottom: 2rem;
    }

    .header-top {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }

    .fair-badge {
      background: #f97316;
      color: #000;
      font-weight: 800;
      font-size: 1.25rem;
      padding: 0.25rem 0.75rem;
      border-radius: 0.5rem;
      letter-spacing: -0.02em;
    }

    .version {
      color: #737373;
      font-size: 0.875rem;
      font-family: ui-monospace, monospace;
    }

    .access-badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.6rem;
      border: 1px solid;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .meta {
      background: #171717;
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .meta-row {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
    }

    .meta-label {
      color: #737373;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      min-width: 5rem;
      flex-shrink: 0;
    }

    .meta-value {
      font-size: 0.875rem;
      color: #d4d4d4;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta-value.did { font-family: ui-monospace, monospace; font-size: 0.8rem; }

    code { font-family: ui-monospace, monospace; font-size: 0.8rem; color: #d4d4d4; }

    section {
      background: #171717;
      border-radius: 0.75rem;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }

    section h2 {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #737373;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #262626;
    }

    /* Attribution */
    .entry { margin-bottom: 0.75rem; }
    .entry:last-child { margin-bottom: 0; }

    .entry-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .role {
      font-size: 0.75rem;
      font-weight: 600;
      color: #f97316;
      text-transform: capitalize;
    }

    .did {
      font-size: 0.75rem;
      color: #737373;
      font-family: ui-monospace, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .verified {
      font-size: 0.65rem;
      color: #34d399;
      background: rgba(52, 211, 153, 0.1);
      border: 1px solid rgba(52, 211, 153, 0.2);
      padding: 0.1rem 0.4rem;
      border-radius: 9999px;
    }

    .share-bar {
      height: 6px;
      background: #262626;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 0.15rem;
    }

    .share-fill {
      height: 100%;
      background: #f97316;
      border-radius: 3px;
      transition: width 0.3s;
    }

    .share-pct {
      font-size: 0.75rem;
      font-family: ui-monospace, monospace;
      color: #a3a3a3;
      text-align: right;
    }

    .note {
      font-size: 0.75rem;
      color: #737373;
      font-style: italic;
      margin-top: 0.25rem;
    }

    /* Fees */
    .fee-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0;
      border-bottom: 1px solid #1f1f1f;
    }
    .fee-row:last-child { border-bottom: none; }

    .fee-name {
      flex: 1;
      font-size: 0.875rem;
      color: #d4d4d4;
    }

    .fee-role {
      font-size: 0.7rem;
      color: #737373;
      font-family: ui-monospace, monospace;
    }

    .fee-rate {
      font-size: 0.875rem;
      font-family: ui-monospace, monospace;
      color: #f97316;
      font-weight: 600;
      min-width: 4rem;
      text-align: right;
    }

    .fee-total {
      display: flex;
      justify-content: space-between;
      padding-top: 0.75rem;
      margin-top: 0.5rem;
      border-top: 1px solid #333;
      font-weight: 700;
      font-size: 0.875rem;
      color: #f97316;
    }

    /* Distribution */
    .dist-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0.5rem 0;
      border-bottom: 1px solid #1f1f1f;
      gap: 1rem;
    }
    .dist-row:last-child { border-bottom: none; }

    .dist-name {
      font-size: 0.875rem;
      color: #d4d4d4;
      font-weight: 500;
      flex-shrink: 0;
    }

    .dist-mode {
      font-size: 0.8rem;
      color: #a3a3a3;
      text-align: right;
    }

    /* Pills */
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      color: #a3a3a3;
      background: #1f1f1f;
      padding: 0.3rem 0.7rem;
      border-radius: 9999px;
    }

    .pill strong { color: #e5e5e5; }

    .pill-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* Signature */
    .sig { display: flex; flex-direction: column; gap: 0.4rem; }

    .sig-row {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
    }

    .sig-label {
      color: #737373;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      min-width: 5rem;
      flex-shrink: 0;
    }

    .sig-value {
      font-size: 0.8rem;
      color: #a3a3a3;
    }

    .sig-hash {
      font-size: 0.7rem;
      color: #4ade80;
      word-break: break-all;
    }

    /* Footer */
    .footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #1f1f1f;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .footer a {
      color: #737373;
      font-size: 0.75rem;
      text-decoration: none;
      transition: color 0.15s;
    }

    .footer a:hover { color: #f97316; }

    @media (max-width: 480px) {
      body { padding: 1rem 0.75rem; }
      .meta-row { flex-direction: column; gap: 0.15rem; }
      .meta-label { min-width: auto; }
      .dist-row { flex-direction: column; gap: 0.25rem; }
      .dist-mode { text-align: left; }
    }
  </style>
</head>
<body>
  <div class="container">
    ${sections.filter(Boolean).join("\n")}
    <div class="footer">
      <a href="https://github.com/ima-jin/.fair" target="_blank" rel="noopener">.fair spec — transparent attribution</a>
      <a href="${esc(jsonUrl)}${jsonUrl.includes("?") ? "&" : "?"}format=json">View JSON</a>
    </div>
  </div>
</body>
</html>`;
}
