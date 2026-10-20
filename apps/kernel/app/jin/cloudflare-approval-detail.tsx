'use client';

import { JsonView } from './cloudflare-editors';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : 'Unavailable'; }
function dns(value: unknown) {
  const row = object(value);
  return { id: text(row.id), name: text(row.name), type: text(row.type),
    content: text(row.content), ttl: typeof row.ttl === 'number' ? row.ttl : null, proxied: row.proxied === true };
}
function rules(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const row = object(item);
    const parameters = object(row.action_parameters);
    const ttl = object(parameters.edge_ttl);
    const browserTtl = object(parameters.browser_ttl);
    return { description: text(row.description), expression: text(row.expression),
      ref: typeof row.ref === 'string' ? row.ref : null,
      enabled: row.enabled === true, cache: typeof parameters.cache === 'boolean' ? parameters.cache : null,
      edgeTtl: { mode: text(ttl.mode), seconds: typeof ttl.default === 'number' ? ttl.default : null },
      browserTtl: { mode: text(browserTtl.mode), seconds: typeof browserTtl.default === 'number' ? browserTtl.default : null } };
  });
}

/** Adapter-supplied detail is untrusted. Render only the identifiers and operation allowlist. */
export function CloudflareApprovalDetail({ detail }: Readonly<{ detail: Record<string, unknown> | null }>) {
  const plan = object(detail);
  const actor = object(plan.actor);
  const valid = ['bulk-proxy', 'cache-set'].includes(text(plan.operation));
  if (!valid) return <p className="text-sm">Cloudflare plan details unavailable — do not approve.</p>;
  const changes = Array.isArray(plan.changes) ? plan.changes.slice(0, 20) : [];
  return <div className="min-w-0 space-y-2">
    <p className="break-all font-mono text-xs">Actor: {text(actor.did)}</p>
    <p className="break-all font-mono text-xs">On behalf of: {text(plan.ownerDid)}</p>
    <p className="break-all font-mono text-xs">Zone: {text(plan.domain)} · {text(plan.zoneId)}</p>
    <p className="font-mono text-xs">Expires: {text(plan.expiresAt)}</p>
    <p className="text-xs">Your countersignature authorizes this exact single-use plan. Current grants, verified ownership and before-state are rechecked at execution.</p>
    {plan.operation === 'bulk-proxy' ? changes.map((change, index) => {
      const row = object(change);
      return <div key={text(row.recordId)} className="space-y-1">
        <h4 className="font-mono text-xs">Record {index + 1} · before → after</h4>
        <JsonView value={{ before: dns(row.before), after: dns(row.after) }} />
      </div>;
    }) : <><h4 className="font-mono text-xs">Ordered cache rules · before → after</h4>
      <JsonView value={{ before: rules(plan.before), after: rules(plan.rules) }} /></>}
    <p className="text-xs">No credential is disclosed. A node-signed history records intent and outcome.</p>
  </div>;
}
