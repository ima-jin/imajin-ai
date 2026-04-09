'use client';

import { useState, useEffect } from 'react';
import { buildPublicUrl } from '@imajin/config';

interface ServiceEntry {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: string;
  category: string;
  url: string;
  externalUrl?: string;
}

interface Groups {
  kernel: ServiceEntry[];
  core: ServiceEntry[];
  creator: ServiceEntry[];
  developer: ServiceEntry[];
  meta: ServiceEntry[];
}

function groupServices(services: ServiceEntry[]): Groups {
  return {
    kernel:    services.filter((s) => s.category === 'kernel'),
    core:      services.filter((s) => s.category === 'core'),
    creator:   services.filter((s) => s.category === 'creator'),
    developer: services.filter((s) => s.category === 'developer'),
    meta:      services.filter((s) => s.category === 'meta'),
  };
}

function ServiceTile({ service, onAuthRequired }: { service: ServiceEntry; onAuthRequired: (url: string) => void }) {
  const isExternal = !!service.externalUrl;

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (service.visibility === 'authenticated' || service.visibility === 'creator') {
      e.preventDefault();
      onAuthRequired(service.url);
    }
  }

  return (
    <a
      href={service.url}
      onClick={handleClick}
      {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
      className="group flex flex-col items-center justify-center gap-2 w-20 h-20 md:w-24 md:h-24 rounded-xl border border-gray-800 hover:border-amber-500/40 hover:bg-amber-500/5 transition-colors"
      title={service.description}
    >
      <span className="text-3xl leading-none">{service.icon}</span>
      <span className="text-xs text-gray-500 group-hover:text-gray-300 transition-colors leading-none">{service.label}</span>
    </a>
  );
}

function TileGroup({ label, services, onAuthRequired }: { label?: string; services: ServiceEntry[]; onAuthRequired: (url: string) => void }) {
  if (services.length === 0) return null;
  return (
    <div>
      {label && (
        <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-3 text-center">{label}</p>
      )}
      <div className="flex flex-wrap justify-center gap-3">
        {services.map((s) => (
          <ServiceTile key={s.name} service={s} onAuthRequired={onAuthRequired} />
        ))}
      </div>
    </div>
  );
}

const SKELETON_KEYS = ['sk0', 'sk1', 'sk2', 'sk3', 'sk4', 'sk5', 'sk6', 'sk7', 'sk8', 'sk9'];

function handleAuthRequired(nextUrl: string) {
  const authUrl = buildPublicUrl('auth');
  globalThis.location.href = `${authUrl}/login?next=${encodeURIComponent(nextUrl)}`;
}

export function LandingGrid() {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forestEnabledServices, setForestEnabledServices] = useState<string[] | null>(null);

  useEffect(() => {
    const registryUrl = buildPublicUrl('registry');
    const authUrl = buildPublicUrl('auth');
    const actingAs = typeof localStorage !== 'undefined' ? localStorage.getItem('imajin:acting-as') : null;

    const requests: Promise<unknown>[] = [
      fetch(`${registryUrl}/api/specs`).then((r) => r.ok ? r.json() : null),
      fetch(`${authUrl}/api/session`, { credentials: 'include' }).then((r) => r.ok ? r.json() : null),
    ];

    if (actingAs) {
      const profileUrl = buildPublicUrl('profile');
      requests.push(
        fetch(`${profileUrl}/api/forest/${encodeURIComponent(actingAs)}/config/public`)
          .then((r) => r.ok ? r.json() : null)
      );
    }

    Promise.all(requests).then(([specData, session, forestConfig]) => {
      if ((specData as { services?: ServiceEntry[] } | null)?.services) {
        setServices((specData as { services: ServiceEntry[] }).services.filter((s) => s.visibility !== 'internal'));
      }
      const tier = (session as { tier?: string } | null)?.tier;
      setAuthed(tier === 'hard' || tier === 'creator');
      if (forestConfig) {
        const cfg = forestConfig as { enabledServices?: string[] };
        setForestEnabledServices(cfg.enabledServices ?? null);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-wrap justify-center gap-3">
        {SKELETON_KEYS.map((id) => (
          <div key={id} className="w-20 h-20 md:w-24 md:h-24 rounded-xl border border-gray-800 bg-gray-900/40 animate-pulse" />
        ))}
      </div>
    );
  }

  let visibleServices = authed
    ? services
    : services.filter((s) => s.visibility === 'public' || s.visibility === 'authenticated' || s.visibility === 'creator');

  if (forestEnabledServices && forestEnabledServices.length > 0) {
    visibleServices = visibleServices.filter((s) => forestEnabledServices.includes(s.name));
  }

  const { kernel, core, creator, developer, meta } = groupServices(visibleServices);

  return (
    <div className="space-y-8">
      <TileGroup label="Kernel Services" services={kernel} onAuthRequired={handleAuthRequired} />
      <TileGroup label="Userspace" services={core} onAuthRequired={handleAuthRequired} />
      <TileGroup label="Creator Tools" services={creator} onAuthRequired={handleAuthRequired} />
      <TileGroup label="Developers" services={developer} onAuthRequired={handleAuthRequired} />
      <TileGroup label="Project" services={meta} onAuthRequired={handleAuthRequired} />
    </div>
  );
}

export function EmailCapture() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [subscribeStatus, setSubscribeStatus] = useState<string>('');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus('loading');
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'landing' }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('done');
        setSubscribeStatus(data.status || '');
        setMessage(data.message || "You're on the list!");
      } else {
        setStatus('error');
        setMessage(data.error || 'Something went wrong');
      }
    } catch {
      setStatus('error');
      setMessage('Something went wrong');
    }
  }

  if (status === 'done') {
    const isPendingVerification = subscribeStatus === 'pending_verification';
    return (
      <div>
        <p className="text-sm text-gray-400">{message}</p>
        {isPendingVerification && (
          <p className="text-xs text-gray-600 mt-1">Click the link in the email to confirm.</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">This is coming.</h2>
        <p className="text-sm text-gray-500 mt-0.5">Join our mailing list to stay informed about updates.</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="bg-gray-900 border border-gray-800 rounded-md px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-amber-500/60 w-48"
        />
        <button
          type="submit"
          disabled={status === 'loading'}
          className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-gray-950 text-sm font-medium rounded-md transition-colors"
        >
          {status === 'loading' ? '…' : 'Subscribe'}
        </button>
      </div>
      {status === 'error' && <span className="text-xs text-red-400">{message}</span>}
    </form>
  );
}
