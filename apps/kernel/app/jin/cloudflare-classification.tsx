'use client';

import { approvalCardAnchorId } from './approval-anchor';
import { classificationPlans } from './cloudflare-classification-client';
import { cfButton, JsonView } from './cloudflare-editors';
import type { CloudflareModel } from './use-cloudflare';

export function CloudflareClassification({ model }: Readonly<{ model: CloudflareModel }>) {
  const { zone, busy, edge } = model;
  const { classification, previews, complete, message, proposals, stagingStarted } = edge;
  if (!classification || !zone) return <output>Classification report unavailable. Refresh zone data to retry.</output>;
  const plans = classificationPlans(classification);
  return <section aria-label="Edge classification report" className="min-w-0 space-y-4">
    <header className="space-y-2">
      <h3 className="font-mono text-lg">Edge route classification · {classification.domain}</h3>
      <p className="text-sm">Generated from route evidence, not hand-picked proxy toggles. A blocking route keeps its entire host DNS-only.</p>
      <p className="border border-white/15 p-3 text-sm">No changes until countersigned. This panel only reads, previews dry runs and stages proposals.
        The operator must review and countersign each proposal in Operator approvals; there is no execution control here.</p>
    </header>
    {classification.warnings.length > 0 && <aside aria-label="Classification warnings" className="space-y-2 border border-[var(--sunset-purple)] p-3">
      <h4 className="font-mono">Review warnings</h4>
      <ul className="list-inside list-disc text-sm">{classification.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
    </aside>}
    <div className="grid min-w-0 gap-3 md:grid-cols-2">{classification.hosts.map(host => <article key={host.hostname} className="min-w-0 space-y-3 border border-white/15 p-3">
      <h4 className="break-all font-mono font-bold">{host.hostname}</h4>
      <p className="font-mono text-sm">Decision: {host.proxied ? 'Proxied · route-specific cache policy' : 'DNS-only'}</p>
      <p className="break-words text-sm">{host.reason}</p>
      {host.blockingRoutes.length > 0 && <div><h5 className="font-mono text-xs">Blocking routes</h5>
        <ul className="list-inside list-disc break-all text-sm">{host.blockingRoutes.map(route => <li key={route}>{route}</li>)}</ul></div>}
      {host.remedy && <p className="break-words text-sm">Remedy: {host.remedy}</p>}
      <ul aria-label={`Record decisions for ${host.hostname}`} className="space-y-2">{host.records.map(record => <li key={record.recordId} className="break-words border-t border-white/10 pt-2 text-xs">
        <p className="break-all font-mono">{record.type} {record.name}</p>
        <p>Before: {record.before ? 'Proxied' : 'DNS-only'} → After: {record.after ? 'Proxied' : 'DNS-only'}</p>
        <p>{record.reason}</p>
      </li>)}</ul>
      <details><summary className="min-h-11 cursor-pointer py-3 font-mono text-sm">Route evidence · {host.routes.length}</summary>
        <ul className="space-y-3">{host.routes.map(route => <li key={`${route.method}:${route.path}:${route.source}`} className="break-words border-t border-white/10 pt-2 text-xs">
          <p className="break-all font-mono">{route.method} {route.path}</p>
          <p className="font-mono">{route.class}</p><p>{route.reason}</p>
          <p className="break-all">Source: {route.source}</p>
        </li>)}</ul>
      </details>
    </article>)}</div>
    <section aria-label="Ordered cache plan" className="space-y-2">
      <h4 className="font-mono">Ordered cache rules · {classification.cacheRules.length}</h4>
      <p className="text-xs">Cache approval replaces the full ordered ruleset. Check the dry-run before/after, including existing rules.</p>
      {classification.cacheRules.length === 0 && <p className="text-sm">Empty replacement: existing cache rules will be removed only after countersignature.</p>}
      {classification.cacheRules.map((rule, index) => <div key={rule.ref ?? rule.expression} className="min-w-0 border border-white/10 p-3">
        <p className="break-words text-sm">{index + 1}. {rule.description}</p><p className="break-all font-mono text-xs">{rule.expression}</p>
        <JsonView value={rule.action_parameters} />
      </div>)}
    </section>
    <section aria-label="Preview and request approval" className="space-y-3 border border-white/15 p-3">
      <h4 className="font-mono">Preview first · {plans.filter(plan => plan.resource === 'bulk').length} proxy batches (at most 20 each)</h4>
      <p className="text-xs">Refresh zone data to regenerate the report and invalidate prior previews. Zone and plan changes require a new complete preview.</p>
      <button type="button" className={cfButton} disabled={busy || !plans.length || stagingStarted}
        onClick={() => void edge.previewClassification(zone)}>Preview all dry runs</button>
      {!plans.length && <p>No proxy or cache changes proposed.</p>}
      <output className="block" aria-live="polite">{message || `${previews.length} / ${plans.length} dry runs previewed`}</output>
      {previews.map((preview, index) => <details key={JSON.stringify(plans[index])}>
        <summary className="min-h-11 cursor-pointer py-3 font-mono text-sm">Dry run {index + 1} · {plans[index]?.resource} · before / after</summary>
        <JsonView value={preview} />
      </details>)}
      <button type="button" className={cfButton} disabled={busy || !complete || !plans.length || stagingStarted}
        onClick={() => void edge.requestClassificationApproval(zone)}>Request approval</button>
      <ul aria-label="Staged proposal links" className="space-y-2">{proposals.map((id, index) => <li key={id}>
        <a className="inline-block min-h-11 break-all py-3 underline" href={`#${approvalCardAnchorId(id)}`}>Review proposal {index + 1}: {id}</a>
      </li>)}</ul>
    </section>
    <details><summary className="min-h-11 cursor-pointer py-3 font-mono text-sm">Cloudflare limits and evidence policy</summary>
      <ul className="space-y-2 text-xs">
        <li><a className="underline" href="https://developers.cloudflare.com/network/websockets/">WebSockets are supported on all plans</a>, but proxy safety requires observed heartbeat and reconnect evidence; support alone is not proof.</li>
        <li><a className="underline" href="https://developers.cloudflare.com/fundamentals/reference/connection-limits/">The documented proxy read timeout is 125 seconds.</a> This report retains the conservative issue threshold of 100 seconds to leave operational headroom.</li>
        <li><a className="underline" href="https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/">Upload limits: Free/Pro 100 MB, Business 200 MB, Enterprise up to 5 GB.</a> Unknown plan or upload evidence must not be assumed safe.</li>
      </ul>
    </details>
  </section>;
}
