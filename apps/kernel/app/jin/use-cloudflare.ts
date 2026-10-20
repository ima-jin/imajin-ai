'use client';

import { useState } from 'react';
import { requestApprovalsRefresh } from './approval-anchor';
import { cloudflareFailure, cloudflareRequest, type CacheRule, type CloudflareHistory, type CloudflareZone, type CustomHostname, type DnsRecord } from './cloudflare-client';

export const sections = ['DNS', 'Settings / SSL', 'SSL', 'Cache rules', 'Custom hostnames', 'Signed history'] as const;
export type Section = typeof sections[number];
type Change = { recordId: string; proxied: boolean };

export function useCloudflare() {
  const [zone, setZone] = useState<CloudflareZone | null>(null);
  const [section, setSection] = useState<Section>('DNS');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [proposal, setProposal] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [rules, setRules] = useState<CacheRule[]>([]);
  const [editingRule, setEditingRule] = useState<number | undefined>();
  const [hostnames, setHostnames] = useState<CustomHostname[]>([]);
  const [history, setHistory] = useState<CloudflareHistory[]>([]);
  const [settings, setSettings] = useState<unknown>(null);
  const [editing, setEditing] = useState<DnsRecord | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [proxy, setProxy] = useState(true);
  const [preview, setPreview] = useState<{ changes: Change[]; data: unknown } | null>(null);
  const [cachePreview, setCachePreview] = useState<{ rules: CacheRule[]; data: unknown } | null>(null);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setNotice(''); setProposal('');
    try { await task(); }
    catch (error) {
      // Only our fixed local messages are eligible for display, never provider or network errors.
      const safe = [401, 403, 409, 500].map(cloudflareFailure);
      setNotice(error instanceof Error && safe.includes(error.message) ? error.message : cloudflareFailure(500));
    } finally { setBusy(false); }
  };
  const load = async (target: CloudflareZone, tab: Section) => {
    if (tab === 'DNS') {
      const data = await cloudflareRequest<{ records: DnsRecord[] }>(target, 'dns');
      if (!Array.isArray(data.records)) throw new Error('invalid');
      setRecords(data.records); setSelected([]); setPreview(null); setEditing(undefined); setDeleting(null);
    } else if (tab === 'Cache rules') {
      const data = await cloudflareRequest<{ rules: CacheRule[] }>(target, 'cache-rules');
      if (!Array.isArray(data.rules)) throw new Error('invalid');
      setRules(data.rules);
      setEditingRule(undefined);
      setCachePreview(null);
    } else if (tab === 'Custom hostnames') {
      const data = await cloudflareRequest<{ hostnames: CustomHostname[] }>(target, 'custom-hostnames');
      if (!Array.isArray(data.hostnames)) throw new Error('invalid');
      setHostnames(data.hostnames);
    } else if (tab === 'Signed history') {
      const data = await cloudflareRequest<{ history: CloudflareHistory[] }>(target, 'history');
      if (!Array.isArray(data.history)) throw new Error('invalid');
      setHistory(data.history);
    } else setSettings(await cloudflareRequest(target, tab === 'SSL' ? 'ssl' : 'settings'));
  };
  const mutate = (resource: string, method: string, body?: unknown) => run(async () => {
    if (!zone) return;
    await cloudflareRequest(zone, resource, method, body);
    await load(zone, section);
    setNotice('Operation completed. Signed history records the outcome.');
  });
  const bulk = (dryRun: boolean) => run(async () => {
    if (!zone) return;
    const changes = dryRun ? selected.map((recordId) => ({ recordId, proxied: proxy })) : preview?.changes;
    if (!changes?.length) return;
    const data = await cloudflareRequest<{ approval?: { proposalId: string } }>(zone, 'bulk', 'POST', { domain: zone.domain, changes, dryRun });
    if (dryRun) { setPreview({ changes, data }); setNotice('Dry-run only. Review before requesting a human countersignature.'); return; }
    if (typeof data.approval?.proposalId !== 'string') throw new Error('invalid');
    setProposal(data.approval.proposalId); setPreview(null);
    setNotice('Pending approval — no bulk changes applied. Countersign as yourself in Operator approvals.');
    requestApprovalsRefresh();
  });
  const cachePlan = (next: CacheRule[], dryRun: boolean) => run(async () => {
    if (!zone) return;
    const cleanRules = next.map(({ id: _id, ...rule }) => rule);
    const data = await cloudflareRequest<{ approval?: { proposalId: string } }>(zone, 'cache-rules', 'PUT', {
      domain: zone.domain, rules: cleanRules, dryRun,
    });
    if (dryRun) { setCachePreview({ rules: cleanRules, data }); setNotice('Cache dry-run only. Review the full ordered ruleset before requesting approval.'); return; }
    if (typeof data.approval?.proposalId !== 'string') throw new Error('invalid');
    setProposal(data.approval.proposalId); setCachePreview(null);
    setNotice('Cache rules pending approval — no changes applied.');
    requestApprovalsRefresh();
  });
  const saveRules = (next: CacheRule[]) => cachePlan(next, true);
  const refreshHostname = (hostname: CustomHostname) => run(async () => {
    if (!zone) return;
    const data = await cloudflareRequest<{ hostname: CustomHostname }>(zone, `custom-hostnames/${encodeURIComponent(hostname.id)}`);
    if (!data.hostname) throw new Error('invalid');
    setHostnames(hostnames.map((item) => item.id === hostname.id ? data.hostname : item));
  });

  return { zone, setZone, section, setSection, busy, notice, proposal, records, setRecords, rules, setRules, editingRule, setEditingRule, hostnames, setHostnames, history, setHistory, settings, setSettings, editing, setEditing, deleting, setDeleting, selected, setSelected, proxy, setProxy, preview, setPreview, cachePreview, setCachePreview, run, load, mutate, bulk, cachePlan, saveRules, refreshHostname, setNotice };
}
export type CloudflareModel = ReturnType<typeof useCloudflare>;
