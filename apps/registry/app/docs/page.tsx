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
  const [specContent, setSpecContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/specs')
      .then(r => r.json())
      .then(data => {
        setServices(data.services);
        if (data.services.length > 0) setSelected(data.services[0].name);
      });
  }, []);

  useEffect(() => {
    if (!selected || !services.length) return;
    const svc = services.find(s => s.name === selected);
    if (!svc) return;

    setLoading(true);
    setError(null);
    setSpecContent(null);

    fetch(svc.spec)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then(text => {
        setSpecContent(text);
        setLoading(false);
      })
      .catch(err => {
        setError(`Could not load spec for ${selected}`);
        setLoading(false);
      });
  }, [selected, services]);

  const svc = services.find(s => s.name === selected);

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Imajin API Documentation</h1>
          <p className="text-gray-400">
            The sovereign stack — identity, payments, attribution, and more.
          </p>
        </div>

        {/* Service tabs */}
        <div className="flex flex-wrap gap-2 mb-8">
          {services.map(s => (
            <button
              key={s.name}
              onClick={() => setSelected(s.name)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                selected === s.name
                  ? 'bg-[#F59E0B] text-black'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Selected service */}
        {svc && (
          <div className="mb-6">
            <h2 className="text-xl font-semibold">
              {svc.name}.imajin.ai
            </h2>
            <p className="text-gray-400 text-sm mt-1">{svc.description}</p>
            <a
              href={svc.spec}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#F59E0B] text-sm hover:underline mt-1 inline-block"
            >
              Raw OpenAPI spec →
            </a>
          </div>
        )}

        {/* Spec content */}
        {loading && (
          <div className="text-gray-500 py-12 text-center">Loading spec...</div>
        )}
        {error && (
          <div className="text-red-400 py-12 text-center">{error}</div>
        )}
        {specContent && !loading && (
          <SpecViewer content={specContent} />
        )}
      </div>
    </div>
  );
}

function SpecViewer({ content }: { content: string }) {
  let spec: any;
  try {
    spec = JSON.parse(content);
  } catch {
    try {
      // Might be YAML — just show raw for now
      return (
        <pre className="bg-black/50 border border-gray-800 rounded-xl p-6 overflow-x-auto text-sm text-gray-300">
          {content}
        </pre>
      );
    } catch {
      return <div className="text-red-400">Could not parse spec</div>;
    }
  }

  const paths = spec.paths || {};

  return (
    <div className="space-y-4">
      {spec.info?.description && (
        <p className="text-gray-400 text-sm mb-6">{spec.info.description}</p>
      )}
      {Object.entries(paths).map(([path, methods]: [string, any]) => (
        <div key={path}>
          {Object.entries(methods).map(([method, details]: [string, any]) => (
            <div
              key={`${method}-${path}`}
              className="bg-black/50 border border-gray-800 rounded-xl p-5 mb-3"
            >
              <div className="flex items-start gap-3 mb-2">
                <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase ${
                  method === 'get' ? 'bg-blue-500/20 text-blue-400' :
                  method === 'post' ? 'bg-green-500/20 text-green-400' :
                  method === 'put' ? 'bg-yellow-500/20 text-yellow-400' :
                  method === 'patch' ? 'bg-orange-500/20 text-orange-400' :
                  method === 'delete' ? 'bg-red-500/20 text-red-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>
                  {method}
                </span>
                <code className="text-sm font-mono text-gray-200">{path}</code>
              </div>
              {details.summary && (
                <p className="text-gray-300 text-sm mb-2">{details.summary}</p>
              )}
              {details.description && details.description !== details.summary && (
                <p className="text-gray-500 text-sm">{details.description}</p>
              )}

              {/* Parameters */}
              {details.parameters?.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Parameters</p>
                  <div className="space-y-1">
                    {details.parameters.map((p: any, i: number) => (
                      <div key={i} className="text-sm flex gap-2">
                        <code className="text-[#F59E0B] text-xs">{p.name}</code>
                        <span className="text-gray-600 text-xs">({p.in})</span>
                        {p.required && <span className="text-red-400 text-xs">required</span>}
                        {p.description && <span className="text-gray-500 text-xs">— {p.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Responses */}
              {details.responses && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Responses</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(details.responses).map(([code, resp]: [string, any]) => (
                      <span
                        key={code}
                        className={`text-xs px-2 py-0.5 rounded ${
                          code.startsWith('2') ? 'bg-green-500/10 text-green-400' :
                          code.startsWith('4') ? 'bg-yellow-500/10 text-yellow-400' :
                          code.startsWith('5') ? 'bg-red-500/10 text-red-400' :
                          'bg-gray-500/10 text-gray-400'
                        }`}
                        title={resp.description}
                      >
                        {code} {resp.description}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
