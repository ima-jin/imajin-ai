import { handleModels, type HandleModelsDeps } from './handle-models.js';
import { CatalogError, resolveRoute } from './router.js';
import type { ProviderRouteConfig } from './types.js';

interface CatalogRow {
  id: string;
  imajin: { connector: string; servable: boolean; picked?: boolean };
}

function isCatalogRow(value: unknown): value is CatalogRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CatalogRow>;
  return typeof row.id === 'string' && row.id.length > 0 &&
    typeof row.imajin?.connector === 'string' && row.imajin.connector.length > 0 &&
    row.imajin.servable === true;
}

/** Kernel's full picker list is authoritative; `picked` is advisory, not a routing filter. */
export class CatalogRouter {
  private readonly cache = new Map<string, { expiresAt: number; models: Map<string, string> }>();
  private readonly pending = new Map<string, Promise<Map<string, string>>>();

  constructor(
    private readonly deps: HandleModelsDeps & { routes: readonly ProviderRouteConfig[] },
    private readonly register: (route: ProviderRouteConfig) => void,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  async resolve(pathProviderId: string | undefined, model: string | undefined): Promise<ProviderRouteConfig | undefined> {
    if (pathProviderId === 'mcp') return undefined;
    const requestedSeat = this.deps.routes.find(route => route.id === (pathProviderId ?? 'openai'));
    const candidates = requestedSeat?.actingAs
      ? this.deps.routes.filter(route => route.principalDid === requestedSeat.principalDid && route.actingAs === requestedSeat.actingAs)
      : this.deps.routes;
    const configured = resolveRoute(candidates, pathProviderId, model);
    // Explicit prefix overrides retain their break-glass endpoint and principal.
    if (configured && (!model || configured.modelPrefixes?.some((prefix) => model.startsWith(prefix)))) return configured;
    if (!model) return undefined;
    const seat = this.deps.routes.find((route) => route.id === (pathProviderId ?? 'openai')) ??
      (!pathProviderId || pathProviderId === 'openai'
        ? this.deps.routes.find((route) => route.id !== 'mcp')
        : undefined);
    if (!seat) return undefined;
    let models = await this.models(seat);
    if (!models.has(model)) models = await this.models(seat, true);
    const connector = models.get(model);
    if (!connector) return undefined;
    const override = this.deps.routes.find((route) =>
      route.id === connector && route.principalDid === seat.principalDid && route.actingAs === seat.actingAs);
    if (override) return override;
    // Internal id avoids collisions with a configured route for another principal.
    const seatId = seat.actingAs ? `${seat.principalDid}:${seat.actingAs}` : seat.principalDid;
    const route = {
      id: `catalog:${seatId}:${connector}`, principalDid: seat.principalDid,
      ...(seat.actingAs ? { actingAs: seat.actingAs } : {}),
    };
    this.register(route);
    return route;
  }

  private models(seat: ProviderRouteConfig, force = false): Promise<Map<string, string>> {
    const key = JSON.stringify([seat.principalDid, seat.actingAs ?? null]);
    const cached = this.cache.get(key);
    if (!force && cached && cached.expiresAt > this.now()) return Promise.resolve(cached.models);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const refresh = this.refresh(seat, key).finally(() => this.pending.delete(key));
    this.pending.set(key, refresh);
    return refresh;
  }

  private async refresh(seat: ProviderRouteConfig, key: string): Promise<Map<string, string>> {
    // Failed refreshes must not leave stale routing authority behind.
    this.cache.delete(key);
    const response = await handleModels(this.deps, seat.id);
    if (response.status !== 200) throw new CatalogError(response.status, 'Kernel usable catalog is unavailable');
    const body = await new Response(response.body).json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) throw new CatalogError(502, 'Kernel usable catalog returned an invalid list');
    const models = new Map<string, string>();
    for (const row of body.data) {
      if (isCatalogRow(row) && !models.has(row.id)) models.set(row.id, row.imajin.connector);
    }
    this.cache.set(key, { models, expiresAt: this.now() + this.ttlMs });
    return models;
  }
}
