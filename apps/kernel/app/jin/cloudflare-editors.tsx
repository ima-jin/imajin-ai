'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { CacheRule, DnsRecord } from './cloudflare-client';

export const cfInput = 'mt-1 min-h-11 w-full min-w-0 border border-white/15 bg-[var(--bg-input)] px-3 py-2 font-mono text-sm focus:border-[var(--sunset-purple)]';
export const cfButton = 'min-h-11 border border-white/15 bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm disabled:opacity-40';
export function JsonView({ value }: Readonly<{ value: unknown }>) {
  return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border border-white/10 p-2 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}
export function CloudflareField({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <label className="block min-w-0 font-mono text-xs">{label}{children}</label>;
}

export function DnsEditor({ record, busy, save, cancel }: Readonly<{
  record: DnsRecord | null; busy: boolean;
  save: (record: Omit<DnsRecord, 'id'>) => Promise<void>; cancel: () => void;
}>) {
  const [type, setType] = useState(record?.type ?? 'A');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void save({
      type, name: String(data.get('name')), content: String(data.get('content')),
      ttl: Number(data.get('ttl')), ...(['A', 'AAAA', 'CNAME'].includes(type) ? { proxied: data.get('proxied') === 'on' } : {}),
      ...(type === 'MX' ? { priority: Number(data.get('priority')) } : {}),
    });
  };
  return <form onSubmit={submit} className="space-y-3 border border-white/15 p-3">
    <h4 className="font-mono">{record ? 'Edit DNS record' : 'Create DNS record'}</h4>
    <div className="grid gap-3 sm:grid-cols-2">
      <CloudflareField label="Record type"><select aria-label="Record type" className={cfInput} value={type} disabled={busy} onChange={(e) => setType(e.target.value)}>
        {['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'].map((value) => <option key={value}>{value}</option>)}
      </select></CloudflareField>
      <CloudflareField label="Record name"><input name="name" required defaultValue={record?.name} className={cfInput} disabled={busy} /></CloudflareField>
      <CloudflareField label="Record content"><input name="content" required defaultValue={record?.content} className={cfInput} disabled={busy} /></CloudflareField>
      <CloudflareField label="TTL seconds (1 = automatic)"><input name="ttl" type="number" min="1" required defaultValue={record?.ttl ?? 1} className={cfInput} disabled={busy} /></CloudflareField>
    </div>
    {type === 'MX' && <CloudflareField label="MX priority"><input name="priority" type="number" min="0" max="65535" defaultValue={record?.priority ?? 10} required disabled={busy} className={cfInput} /></CloudflareField>}
    {['A', 'AAAA', 'CNAME'].includes(type) && <label className="flex min-h-11 items-center gap-2 font-mono text-sm">
      <input type="checkbox" name="proxied" defaultChecked={record?.proxied ?? false} disabled={busy} />Proxied through Cloudflare
    </label>}
    <div className="flex flex-wrap gap-2"><button disabled={busy} className={cfButton} type="submit">Save DNS record</button>
      <button disabled={busy} className={cfButton} type="button" onClick={cancel}>Cancel DNS edit</button></div>
  </form>;
}

export function CacheRuleEditor({ rules, busy, save, editing, cancel, onDirty }: Readonly<{
  rules: CacheRule[]; busy: boolean; save: (rules: CacheRule[]) => Promise<void>;
  editing?: number; cancel?: () => void;
  onDirty?: () => void;
}>) {
  const current = editing === undefined ? undefined : rules[editing];
  return <form className="space-y-3" onChange={onDirty} onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const mode = data.get('mode');
    const parameters = { ...current?.action_parameters };
    delete parameters.edge_ttl;
    const rule: CacheRule = {
      ...current,
      description: String(data.get('description')), expression: String(data.get('expression')),
      action: 'set_cache_settings', enabled: current?.enabled ?? true,
      action_parameters: {
        ...parameters, cache: mode !== 'bypass',
        ...(mode === 'ttl' ? { edge_ttl: { mode: 'override_origin', default: Number(data.get('ttl')) } } : {}),
        ...(['respect_origin', 'bypass_by_default'].includes(String(mode)) ? { edge_ttl: { mode: mode as 'respect_origin' | 'bypass_by_default' } } : {}),
      },
    };
    void save(editing === undefined ? [...rules, rule] : rules.map((item, index) => index === editing ? rule : item));
  }}>
    <CloudflareField label="Rule description"><input name="description" defaultValue={current?.description} required maxLength={200} className={cfInput} disabled={busy} /></CloudflareField>
    <CloudflareField label="Match expression"><input name="expression" defaultValue={current?.expression} required placeholder={'http.host eq "www.example.com"'} className={cfInput} disabled={busy} /></CloudflareField>
    <CloudflareField label="Cache behavior"><select name="mode" defaultValue={current?.action_parameters.edge_ttl?.mode === 'override_origin' ? 'ttl' : current?.action_parameters.edge_ttl?.mode ?? (current?.action_parameters.cache === false ? 'bypass' : 'eligible')} className={cfInput} disabled={busy}>
      <option value="eligible">Eligible for cache</option><option value="bypass">Bypass cache</option><option value="ttl">Override edge TTL</option>
      <option value="respect_origin">Respect origin edge TTL</option><option value="bypass_by_default">Bypass edge cache unless origin allows</option>
    </select></CloudflareField>
    <CloudflareField label="Edge TTL seconds (override only)"><input name="ttl" type="number" min="1" defaultValue={current?.action_parameters.edge_ttl?.default ?? 3600} className={cfInput} disabled={busy} /></CloudflareField>
    <button type="submit" disabled={busy || rules.length >= 20 && !current} className={cfButton}>{current ? 'Preview cache rule edit' : 'Preview new cache rule'}</button>
    {current && <button type="button" disabled={busy} className={cfButton} onClick={cancel}>Cancel cache edit</button>}
  </form>;
}
