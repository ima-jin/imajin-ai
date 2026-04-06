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
    fetch('/api/specs')
      .then(r => r.json())
      .then(data => {
        setServices(data.services);
        if (data.services.length > 0) setSelected(data.services[0].name);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;

    setLoading(true);
    setError(null);
    setSpec(null);

    // Fetch through local proxy to avoid CORS
    fetch(`/api/specs/${selected}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then(text => {
        // Try JSON first, then try basic YAML parse
        try {
          setSpec(JSON.parse(text));
        } catch {
          try {
            setSpec(parseSimpleYaml(text));
          } catch {
            setError('Could not parse spec');
          }
        }
        setLoading(false);
      })
      .catch(() => {
        setError(`Could not load spec for ${selected}`);
        setLoading(false);
      });
  }, [selected]);

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

        {svc && (
          <div className="mb-6">
            <h2 className="text-xl font-semibold">{svc.name}.imajin.ai</h2>
            <p className="text-gray-400 text-sm mt-1">{svc.description}</p>
            <a href={svc.spec} target="_blank" rel="noopener noreferrer"
              className="text-[#F59E0B] text-sm hover:underline mt-1 inline-block">
              Raw OpenAPI spec \u2192
            </a>
          </div>
        )}

        {loading && <div className="text-gray-500 py-12 text-center">Loading spec...</div>}
        {error && <div className="text-red-400 py-12 text-center">{error}</div>}
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
        <p className="text-gray-400 text-sm mb-6">{spec.info.description}</p>
      )}
      {Object.entries(paths).map(([path, methods]: [string, any]) => (
        <div key={path}>
          {Object.entries(methods).filter(([m]) => ['get','post','put','patch','delete'].includes(m)).map(([method, details]: [string, any]) => (
            <div key={`${method}-${path}`}
              className="bg-black/50 border border-gray-800 rounded-xl p-5 mb-3">
              <div className="flex items-start gap-3 mb-2">
                <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase ${
                  method === 'get' ? 'bg-blue-500/20 text-blue-400' :
                  method === 'post' ? 'bg-green-500/20 text-green-400' :
                  method === 'put' ? 'bg-yellow-500/20 text-yellow-400' :
                  method === 'patch' ? 'bg-orange-500/20 text-orange-400' :
                  method === 'delete' ? 'bg-red-500/20 text-red-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>{method}</span>
                <code className="text-sm font-mono text-gray-200">{path}</code>
              </div>
              {details.summary && <p className="text-gray-300 text-sm mb-2">{details.summary}</p>}
              {details.description && details.description !== details.summary && (
                <p className="text-gray-500 text-sm">{details.description}</p>
              )}
              {details.parameters?.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Parameters</p>
                  <div className="space-y-1">
                    {details.parameters.map((p: any, i: number) => (
                      <div key={i} className="text-sm flex gap-2">
                        <code className="text-[#F59E0B] text-xs">{p.name}</code>
                        <span className="text-gray-600 text-xs">({p.in})</span>
                        {p.required && <span className="text-red-400 text-xs">required</span>}
                        {p.description && <span className="text-gray-500 text-xs">\u2014 {p.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {details.responses && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Responses</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(details.responses).map(([code, resp]: [string, any]) => (
                      <span key={code} className={`text-xs px-2 py-0.5 rounded ${
                        code.startsWith('2') ? 'bg-green-500/10 text-green-400' :
                        code.startsWith('4') ? 'bg-yellow-500/10 text-yellow-400' :
                        code.startsWith('5') ? 'bg-red-500/10 text-red-400' :
                        'bg-gray-500/10 text-gray-400'
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
        <div className="text-gray-500 py-8 text-center">No endpoints documented yet.</div>
      )}
    </div>
  );
}

// Simple YAML-to-JSON for OpenAPI specs (handles the subset we generate)
function parseSimpleYaml(yaml: string): any {
  // Use a simple line-based parser for our OpenAPI YAML
  const lines = yaml.split('\n');
  const root: any = {};
  const stack: { obj: any; indent: number; key: string }[] = [{ obj: root, indent: -1, key: '' }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    
    // Pop stack to correct level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    
    const parent = stack[stack.length - 1].obj;
    
    if (trimmed.startsWith('- ')) {
      // Array item
      const key = stack[stack.length - 1].key;
      if (!Array.isArray(parent[key])) parent[key] = [];
      const val = trimmed.slice(2).trim();
      if (val.includes(': ')) {
        const obj: any = {};
        const [k, ...rest] = val.split(': ');
        obj[k] = rest.join(': ').replace(/^['"](.*)['"]$/, '');
        parent[key].push(obj);
        stack.push({ obj: obj, indent: indent + 2, key: k });
      } else {
        parent[key].push(val.replace(/^['"](.*)['"]$/, ''));
      }
    } else if (trimmed.includes(': ')) {
      const colonIdx = trimmed.indexOf(': ');
      const key = trimmed.slice(0, colonIdx).replace(/^['"](.*)['"]$/, '');
      const val = trimmed.slice(colonIdx + 2).trim();
      
      if (val === '' || val === '|' || val === '>') {
        // Nested object or block scalar
        parent[key] = {};
        stack.push({ obj: parent[key], indent: indent, key: key });
      } else if (val === 'true') {
        parent[key] = true;
      } else if (val === 'false') {
        parent[key] = false;
      } else if (!isNaN(Number(val)) && val !== '') {
        parent[key] = Number(val);
      } else {
        parent[key] = val.replace(/^['"](.*)['"]$/, '');
      }
      // Track the key for potential array children
      if (stack.length > 0) stack[stack.length - 1].key = key;
    } else if (trimmed.endsWith(':')) {
      const key = trimmed.slice(0, -1).replace(/^['"](.*)['"]$/, '');
      parent[key] = {};
      stack.push({ obj: parent[key], indent: indent, key: key });
    }
  }
  
  return root;
}
