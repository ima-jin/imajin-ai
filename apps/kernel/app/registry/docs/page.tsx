'use client';

import { useState, useEffect } from 'react';

interface Service {
  name: string;
  description: string;
  url: string;
  spec: string;
}

export default function DocsPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [spec, setSpec] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/registry/api/specs')
      .then(r => r.json())
      .then(data => {
        // Filter to services that have a spec endpoint (exclude meta: project, github, docs)
        const withSpecs = (data.services || []).filter((s: Service) => s.spec);
        setServices(withSpecs);
        if (withSpecs.length > 0) setSelected(withSpecs[0].name);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;

    setLoading(true);
    setError(null);
    setSpec(null);

    // Fetch through local proxy (returns JSON)
    fetch(`/registry/api/specs/${selected}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(data => {
        setSpec(data);
        setLoading(false);
      })
      .catch(() => {
        setError(`Could not load spec for ${selected}`);
        setLoading(false);
      });
  }, [selected]);

  const svc = services.find(s => s.name === selected);

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-primary">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2 font-mono">Imajin API Documentation</h1>
          <p className="text-secondary">
            The sovereign stack — identity, payments, attribution, and more.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 mb-8">
          {services.map(s => (
            <button
              key={s.name}
              onClick={() => setSelected(s.name)}
              className={`px-4 py-2 text-sm font-medium transition ${
                selected === s.name
                  ? 'bg-[#F59E0B] text-black'
                  : 'bg-surface-elevated text-primary hover:bg-surface-elevated'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>

        {svc && (
          <div className="mb-6">
            <h2 className="text-xl font-semibold font-mono">{svc.name}</h2>
            <p className="text-secondary text-sm mt-1">{svc.description}</p>
            <a href={svc.spec} target="_blank" rel="noopener noreferrer"
              className="text-[#F59E0B] text-sm hover:underline mt-1 inline-block">
              Raw OpenAPI spec \u2192
            </a>
          </div>
        )}

        {loading && <div className="text-secondary py-12 text-center">Loading spec...</div>}
        {error && <div className="text-error py-12 text-center">{error}</div>}
        {spec && !loading && <SpecViewer spec={spec} />}
      </div>
    </div>
  );
}

function SpecViewer({ spec }: { spec: any }) {
  const paths = spec.paths || {};

  return (
    <div className="space-y-4">
      {spec.info?.description && (
        <p className="text-secondary text-sm mb-6">{spec.info.description}</p>
      )}
      {Object.entries(paths).map(([path, methods]: [string, any]) => (
        <div key={path}>
          {Object.entries(methods).filter(([m]) => ['get','post','put','patch','delete'].includes(m)).map(([method, details]: [string, any]) => (
            <div key={`${method}-${path}`}
              className="bg-surface-base/50 border border-white/10 p-5 mb-3">
              <div className="flex items-start gap-3 mb-2">
                <span className={`px-2.5 py-1  text-xs font-bold uppercase ${
                  method === 'get' ? 'bg-blue-500/20 text-blue-400' :
                  method === 'post' ? 'bg-success/20 text-success' :
                  method === 'put' ? 'bg-warning/20 text-warning' :
                  method === 'patch' ? 'bg-imajin-orange/20 text-imajin-orange' :
                  method === 'delete' ? 'bg-error/20 text-error' :
                  'bg-gray-500/20 text-secondary'
                }`}>{method}</span>
                <code className="text-sm font-mono text-primary">{path}</code>
              </div>
              {details.summary && <p className="text-primary text-sm mb-2">{details.summary}</p>}
              {details.description && details.description !== details.summary && (
                <p className="text-secondary text-sm">{details.description}</p>
              )}
              {details.parameters?.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-secondary uppercase mb-1">Parameters</p>
                  <div className="space-y-1">
                    {details.parameters.map((p: any, i: number) => (
                      <div key={i} className="text-sm flex gap-2">
                        <code className="text-[#F59E0B] text-xs">{p.name}</code>
                        <span className="text-muted text-xs">({p.in})</span>
                        {p.required && <span className="text-error text-xs">required</span>}
                        {p.description && <span className="text-secondary text-xs">\u2014 {p.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {details.responses && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-secondary uppercase mb-1">Responses</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(details.responses).map(([code, resp]: [string, any]) => (
                      <span key={code} className={`text-xs px-2 py-0.5  ${
                        code.startsWith('2') ? 'bg-success/10 text-success' :
                        code.startsWith('4') ? 'bg-warning/10 text-warning' :
                        code.startsWith('5') ? 'bg-error/10 text-error' :
                        'bg-gray-500/10 text-secondary'
                      }`} title={typeof resp === 'string' ? resp : resp.description}>
                        {code} {typeof resp === 'string' ? resp : resp.description}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {Object.keys(paths).length === 0 && (
        <div className="text-secondary py-8 text-center">No endpoints documented yet.</div>
      )}
    </div>
  );
}
