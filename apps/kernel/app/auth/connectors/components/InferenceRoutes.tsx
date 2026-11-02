'use client';

import { useEffect, useState } from 'react';
import type { InferenceRoute } from '@/src/lib/inference/route-discovery';

const ROUTE_LABELS = {
  own: 'Own', A: "A · Organization's agent", B: "B · Human's agent", C: 'C · Member grant',
} as const;

export function InferenceRoutes() {
  const [routes, setRoutes] = useState<InferenceRoute[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // Same-origin credentials carry the verified x-acting-as cookie; never derive billing from the personal session.
    fetch('/infer/v1/models/usable?explain=1', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Routes unavailable');
        const body = await response.json() as { routes?: InferenceRoute[] };
        if (!Array.isArray(body.routes)) throw new Error('Routes unavailable');
        if (!controller.signal.aborted) setRoutes(body.routes);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="inference-routes-heading" className="mb-8 rounded-xl border border-white/10 p-5">
      <h2 id="inference-routes-heading" className="text-lg font-semibold text-white">Inference routes</h2>
      <p className="mt-1 mb-4 text-sm text-gray-400">Which card can run inference, and who pays. Authorization is checked again on every call.</p>
      {error && <p role="alert" className="text-sm text-amber-300">Inference routes unavailable. Refresh to try again.</p>}
      {!error && routes === null && <p className="text-sm text-gray-400">Loading inference routes…</p>}
      {routes?.length === 0 && <p className="text-sm text-gray-400">No inference routes found for this identity.</p>}
      {!!routes?.length && (
        <ul className="space-y-3">
          {routes.map(route => (
            <li key={`${route.kind}:${route.billedPrincipal.did}:${route.card.id}`}
              className="rounded-lg bg-white/5 p-3 text-sm break-words">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-white">{ROUTE_LABELS[route.kind]}</span>
                <span className={route.usable ? 'text-green-400' : 'text-amber-300'}>Usable: {route.usable ? 'yes' : 'no'}</span>
              </div>
              <p className="mt-1 text-gray-300">Billed to: {route.billedPrincipal.handle ? `@${route.billedPrincipal.handle}` : route.billedPrincipal.did}</p>
              <p className="text-xs text-gray-500 break-all">{route.billedPrincipal.did}</p>
              <p className="mt-1 text-gray-300">{route.card.provider} · {route.card.label}</p>
              <p className="text-xs text-gray-500 break-all">Card: {route.card.id} · Loaded: {route.card.loaded ? 'yes' : 'no'}</p>
              <p className="text-gray-300">Selected model: {route.selectedModels.join(', ') || 'None'}</p>
              {route.reason && <p className="mt-1 text-amber-300">{route.reason.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
