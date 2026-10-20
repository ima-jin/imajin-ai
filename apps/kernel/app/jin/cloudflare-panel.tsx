'use client';
import './cloudflare.css';

import { approvalCardAnchorId } from './approval-anchor';
import { CloudflareField, JsonView, cfButton, cfInput } from './cloudflare-editors';
import { validCloudflareZone } from './cloudflare-client';
import { sections, useCloudflare, type Section } from './use-cloudflare';
import { CloudflareDnsTab, CloudflareCacheTab, CloudflareHostnamesTab, CloudflareHistoryTab } from './cloudflare-tabs';

/** No token input: custody and grant issuance stay on the existing Import credential rail. */
export function CloudflarePanel() {
  const model = useCloudflare();
  const { zone, setZone, section, setSection, busy, notice, proposal, settings, setRecords, setRules, setHistory, setHostnames, setSettings, setPreview, setNotice, run, load } = model;
  return <section className="cloudflare-surface mt-8 min-w-0 space-y-3 border border-white/10 p-3" data-testid="cloudflare-panel">
    <h2 className="font-mono text-base font-bold">Cloudflare operations</h2>
    <p className="text-sm text-[var(--text-secondary)]">Use an exact verified zone domain and its Cloudflare zone ID.
      Import and seal credentials through Import credential above; this panel never receives keys.
      Actions use your authenticated DID, not an acting identity. Revoking the zone capability stops future operations.</p>
    <form className="grid min-w-0 gap-3 sm:grid-cols-2" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const target = { domain: String(data.get('domain')).trim(), zoneId: String(data.get('zoneId')).trim() };
      const initial = String(data.get('view')) as Section;
      if (!validCloudflareZone(target)) { setNotice('Enter a canonical lowercase domain and a 32-character lowercase hexadecimal zone ID.'); return; }
      setZone(null); setRecords([]); setRules([]); setHistory([]); setHostnames([]); setSettings(null); setPreview(null);
      void run(async () => { await load(target, initial); setZone(target); setSection(initial); });
    }}>
      <CloudflareField label="Verified zone domain"><input name="domain" placeholder="example.com" required autoCapitalize="none" spellCheck={false} disabled={busy} className={cfInput} /></CloudflareField>
      <CloudflareField label="Cloudflare zone ID"><input name="zoneId" required pattern="[a-f0-9]{32}" autoCapitalize="none" spellCheck={false} disabled={busy} className={cfInput} /></CloudflareField>
      <CloudflareField label="Initial zone view"><select name="view" className={cfInput} disabled={busy}>{sections.map((tab) => <option key={tab}>{tab}</option>)}</select></CloudflareField>
      <button type="submit" disabled={busy} className={cfButton}>Load zone</button>
    </form>
    {notice && <output aria-live="polite" className="block break-words text-sm text-[var(--sunset-purple)]">{notice}
      {proposal && <> <a className="underline" href={`#${approvalCardAnchorId(proposal)}`}>Review Cloudflare proposal</a></>}
    </output>}
    {zone && <>
      <p className="break-all font-mono text-xs">{zone.domain} · {zone.zoneId}</p>
      <nav aria-label="Cloudflare operations" className="flex flex-wrap gap-2">
        {sections.map((tab) => <button key={tab} type="button" disabled={busy} aria-pressed={section === tab} className={cfButton}
          onClick={() => void run(async () => { await load(zone, tab); setSection(tab); })}>{tab}</button>)}
        <button type="button" className={cfButton} disabled={busy} onClick={() => void run(() => load(zone, section))}>Refresh zone data</button>
      </nav>
      {section === 'DNS' && <CloudflareDnsTab model={model} />}
      {(section === 'Settings / SSL' || section === 'SSL') && <div><h3 className="font-mono">Zone settings and SSL · read only</h3><JsonView value={settings} /></div>}
      {section === 'Cache rules' && <CloudflareCacheTab model={model} />}
      {section === 'Custom hostnames' && <CloudflareHostnamesTab model={model} />}
      {section === 'Signed history' && <CloudflareHistoryTab model={model} />}
    </>}
  </section>;
}
