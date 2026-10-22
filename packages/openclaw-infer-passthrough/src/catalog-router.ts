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
    const configured = resolveRoute(this.deps.routes, pathProviderId, model);
    // Explicit prefix overrides retain their break-glass endpoint and principal.
    if (configured && (!model || configured.modelPrefixes?.some((prefix) => model.startsWith(prefix)))) return configured;
    if (!model || pathProviderId === 'mcp') return undefined;
    const seat = this.deps.routes.find((route) => route.id === (pathProviderId ?? 'openai')) ??
      (!pathProviderId || pathProviderId === 'openai'
        ? this.deps.routes.find((route) => route.id !== 'mcp' && route.id !== 'anthropic')
        : undefined);
    if (!seat) return undefined;
    let models = await this.models(seat);
    if (!models.has(model)) models = await this.models(seat, true);
    const connector = models.get(model);
    if (!connector) return undefined;
    const override = this.deps.routes.find((route) => route.id === connector && route.principalDid === seat.principalDid);
    if (override) return override;
    // Internal id avoids collisions with a configured route for another principal.
    const route = { id: `catalog:${seat.principalDid}:${connector}`, principalDid: seat.principalDid };
    this.register(route);
    return route;
  }

  private models(seat: ProviderRouteConfig, force = false): Promise<Map<string, string>> {
    const cached = this.cache.get(seat.principalDid);
    if (!force && cached && cached.expiresAt > this.now()) return Promise.resolve(cached.models);
    const pending = this.pending.get(seat.principalDid);
    if (pending) return pending;
    const refresh = this.refresh(seat).finally(() => this.pending.delete(seat.principalDid));
    this.pending.set(seat.principalDid, refresh);
    return refresh;
  }

  private async refresh(seat: ProviderRouteConfig): Promise<Map<string, string>> {
    // Failed refreshes must not leave stale routing authority behind.
    this.cache.delete(seat.principalDid);
    const response = await handleModels(this.deps, seat.id);
    if (response.status !== 200) throw new CatalogError(response.status, 'Kernel usable catalog is unavailable');
    const body = await new Response(response.body).json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) throw new CatalogError(502, 'Kernel usable catalog returned an invalid list');
    const models = new Map<string, string>();
    for (const row of body.data) {
      if (isCatalogRow(row) && !models.has(row.id)) models.set(row.id, row.imajin.connector);
    }
    this.cache.set(seat.principalDid, { models, expiresAt: this.now() + this.ttlMs });
    return models;
  }
}
