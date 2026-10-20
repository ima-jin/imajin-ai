'use client';

import { CacheRuleEditor, CloudflareField, DnsEditor, JsonView, cfButton, cfInput } from './cloudflare-editors';
import type { CloudflareModel } from './use-cloudflare';

export function CloudflareDnsTab({ model }: Readonly<{ model: CloudflareModel }>) {
  const { busy, records, selected, setSelected, setPreview, editing, setEditing, deleting, setDeleting, proxy, setProxy, preview, mutate, bulk } = model;
  return <div className="space-y-3">
        <button type="button" disabled={busy} className={cfButton} onClick={() => setEditing(null)}>Create DNS record</button>
        {editing !== undefined && <DnsEditor key={editing?.id ?? 'new'} record={editing} busy={busy} cancel={() => setEditing(undefined)}
          save={(body) => mutate(editing ? `dns/${encodeURIComponent(editing.id)}` : 'dns', editing ? 'PATCH' : 'POST', body)} />}
        {records.length === 0 && <p>No DNS records.</p>}
        <div className="grid min-w-0 gap-3 md:grid-cols-2">{records.map((record) => <article key={record.id} className="min-w-0 space-y-2 border border-white/10 p-3">
          <p className="break-all font-mono text-sm">{record.type} · {record.name}</p>
          <p className="break-all font-mono text-xs">{record.content} · TTL {record.ttl}</p>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(record.id)} disabled={busy || record.proxiable === false || !['A', 'AAAA', 'CNAME'].includes(record.type)}
            onChange={(event) => { setSelected(event.target.checked ? [...selected, record.id] : selected.filter((id) => id !== record.id)); setPreview(null); }} />Select {record.name}</label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={record.proxied ?? false}
            disabled={busy || record.proxiable === false || !['A', 'AAAA', 'CNAME'].includes(record.type)}
            onChange={(event) => void mutate(`dns/${encodeURIComponent(record.id)}`, 'PATCH', { proxied: event.target.checked })} />Proxy {record.name} through Cloudflare</label>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={cfButton} onClick={() => setEditing(record)}>Edit {record.name}</button>
            <button type="button" disabled={busy} className={cfButton} onClick={() => setDeleting(record)}>Delete {record.name}</button></div>
        </article>)}</div>
        {deleting && <div role="alert" className="space-y-2 border border-imajin-red p-3">
          <p className="break-all">Permanently delete {deleting.name} ({deleting.type})?</p>
          <button className={cfButton} disabled={busy} onClick={() => void mutate(`dns/${encodeURIComponent(deleting.id)}`, 'DELETE')}>Confirm DNS deletion</button>
          <button className={cfButton} disabled={busy} onClick={() => setDeleting(null)}>Cancel deletion</button>
        </div>}
        <div className="space-y-2 border border-white/15 p-3">
          <h3 className="font-mono">Bulk proxy plan · {selected.length} / 20 selected</h3>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={proxy} disabled={busy} onChange={(event) => { setProxy(event.target.checked); setPreview(null); }} />Enable proxy for selected records (unchecked disables)</label>
          <button type="button" className={cfButton} disabled={busy || !selected.length || selected.length > 20} onClick={() => void bulk(true)}>Preview bulk changes</button>
          {preview && <><JsonView value={preview.data} /><button type="button" className={cfButton} disabled={busy} onClick={() => void bulk(false)}>Request bulk approval</button></>}
          <p className="text-xs">Preview does not apply changes. Approval is single-use, reauthorized and rejected if record state changed.</p>
        </div>
      </div>;
}

export function CloudflareCacheTab({ model }: Readonly<{ model: CloudflareModel }>) {
  const { busy, rules, editingRule, setEditingRule, saveRules, cachePreview, cachePlan, setCachePreview } = model;
  return <div className="space-y-3">
        <p className="text-xs">Rules are ordered. Saving replaces the zone&apos;s cache ruleset; refresh before editing.</p>
        {rules.map((rule, index) => <article key={rule.id ?? index} className="space-y-2 border border-white/10 p-3">
          <h3 className="break-words font-mono">{rule.description || 'Cache rule'}</h3>
          <p className="break-all font-mono text-xs">{rule.expression}</p><JsonView value={rule.action_parameters} />
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={rule.enabled} disabled={busy}
            onChange={(event) => void saveRules(rules.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item))} />Rule enabled</label>
          <button disabled={busy} className={cfButton} onClick={() => void saveRules(rules.filter((_, i) => i !== index))}>Remove rule {index + 1}</button>
          <button disabled={busy} className={cfButton} onClick={() => { setCachePreview(null); setEditingRule(index); }}>Edit rule {index + 1}</button>
        </article>)}
        <CacheRuleEditor key={editingRule ?? 'new'} rules={rules} busy={busy} save={saveRules} editing={editingRule} cancel={() => setEditingRule(undefined)} onDirty={() => setCachePreview(null)} />
        {cachePreview && <><JsonView value={cachePreview.data} /><button type="button" className={cfButton} disabled={busy}
          onClick={() => void cachePlan(cachePreview.rules, false)}>Request cache approval</button></>}
      </div>;
}

export function CloudflareHostnamesTab({ model }: Readonly<{ model: CloudflareModel }>) {
  const { busy, hostnames, mutate, refreshHostname } = model;
  return <div className="space-y-3">
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void mutate('custom-hostnames', 'POST', { hostname: String(data.get('hostname')), ssl: { method: 'txt', type: 'dv' } });
        }}>
          <CloudflareField label="Custom hostname"><input name="hostname" required placeholder="customer.example.net" className={cfInput} disabled={busy} /></CloudflareField>
          <button type="submit" disabled={busy} className={cfButton}>Create custom hostname</button>
        </form>
        {hostnames.map((hostname) => <article key={hostname.id} className="min-w-0 space-y-2 border border-white/10 p-3">
          <p className="break-all font-mono">{hostname.hostname}</p><p>Status: {hostname.status ?? 'pending'} · SSL: {hostname.ssl?.status ?? 'pending'}</p>
          <h4 className="font-mono text-xs">Ownership and certificate validation</h4>
          <p className="text-xs">Publish the returned verification record at your DNS provider, then check status. No DNS credentials are exposed.</p>
          <JsonView value={{ ownership: hostname.ownership_verification, http: hostname.ownership_verification_http, certificate: hostname.ssl?.validation_records }} />
          <button className={cfButton} disabled={busy} onClick={() => void refreshHostname(hostname)}>Check status {hostname.hostname}</button>
          <button className={cfButton} disabled={busy} onClick={() => void mutate(`custom-hostnames/${encodeURIComponent(hostname.id)}`, 'DELETE')}>Delete hostname {hostname.hostname}</button>
        </article>)}
      </div>;
}

export function CloudflareHistoryTab({ model }: Readonly<{ model: CloudflareModel }>) {
  const { history } = model;
  return <div className="space-y-3">
        <p className="text-xs">Node signatures witness recorded intent/outcomes; they do not prove provider state independently.</p>
        {history.length === 0 && <p>No signed history yet.</p>}
        {history.map((entry) => <article key={entry.id} className="min-w-0 space-y-2 border border-white/10 p-3">
          <h3 className="break-all font-mono">{entry.payload.operation} · {entry.payload.phase}</h3>
          <p className="break-all text-xs">Actor: {entry.payload.actorDid}</p><p className="break-all text-xs">On behalf of: {entry.payload.onBehalfOf}</p>
          <p className="break-all text-xs">Zone: {entry.payload.zoneId}</p>
          <p className="break-all text-xs">Issuer: {entry.issuerDid} · <time dateTime={entry.issuedAt}>{entry.issuedAt}</time></p>
          <h4 className="font-mono text-xs">Before</h4><JsonView value={entry.payload.before} />
          <h4 className="font-mono text-xs">After</h4><JsonView value={entry.payload.after} />
          <h4 className="font-mono text-xs">Signature</h4><JsonView value={entry.signature} />
        </article>)}
      </div>;
}
