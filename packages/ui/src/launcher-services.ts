import { getActingAsHeaders } from './acting-as';

export interface LauncherService {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: 'public' | 'authenticated' | 'creator' | 'internal';
  category: 'kernel' | 'core' | 'creator' | 'developer' | 'infrastructure' | 'meta';
  url: string;
  externalUrl?: string;
  source?: 'static' | 'registry';
}

interface RegistryApp {
  slug: string;
  name: string;
  icon: string | null;
  entryUrl: string | null;
}

/** Only kernel/project infrastructure can bypass the person's registry list. */
function isKernelEntry(service: LauncherService): boolean {
  return service.source === 'static' && (service.category === 'kernel' || service.category === 'meta');
}

async function readPublicServices(registryUrl: string): Promise<LauncherService[]> {
  try {
    const response = await fetch(`${registryUrl}/api/launcher`);
    if (!response.ok) return [];
    const data = await response.json() as { services?: LauncherService[] };
    const registry = new URL(registryUrl, globalThis.location.href);
    if (registry.origin === globalThis.location.origin) return data.services ?? [];
    // A kernel in single-node mode returns relative URLs. In a published
    // SDK consumer those paths belong to the kernel, not the app's origin.
    return (data.services ?? []).map((service) => ({
      ...service,
      url: new URL(service.url || '/', registry).href,
    }));
  } catch {
    return [];
  }
}

function appEntry(app: RegistryApp, publicServices: LauncherService[], authUrl: string): LauncherService {
  const hint = publicServices.find((service) => service.source === 'registry' && service.name === app.slug);
  return {
    name: app.slug,
    label: app.name,
    description: hint?.description ?? app.name,
    icon: app.icon ?? hint?.icon ?? '🧩',
    visibility: hint?.visibility ?? 'public',
    category: 'core',
    url: hint?.url ?? new URL(app.entryUrl || `/${encodeURIComponent(app.slug)}`, new URL(authUrl, globalThis.location.href)).href,
    source: 'registry',
  };
}

/**
 * The public endpoint supplies kernel infrastructure and anonymous discovery.
 * For signed-in people the authenticated response is the app SET, not merely
 * an intersection with public discovery (scope-gated registry apps belong too).
 */
export async function loadLauncherServices(
  registryUrl: string,
  authUrl: string,
  signedIn: boolean,
): Promise<LauncherService[]> {
  const publicServices = await readPublicServices(registryUrl);
  if (!signedIn) return publicServices;
  const kernel = publicServices.filter(isKernelEntry);
  try {
    const response = await fetch(`${authUrl}/api/apps?placement=launcher`, {
      credentials: 'include',
      headers: getActingAsHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Identity app list unavailable');
    const data = await response.json() as { apps?: RegistryApp[] };
    if (!Array.isArray(data.apps)) throw new Error('Invalid identity app list');
    return [...kernel, ...data.apps.map((app) => appEntry(app, publicServices, authUrl))];
  } catch {
    // Standalone SDK consumers may not have a kernel cookie/CORS permission.
    // Same-origin failures must not turn a private list into every public app.
    const crossOrigin = new URL(authUrl, globalThis.location.href).origin !== globalThis.location.origin;
    return crossOrigin ? publicServices : kernel;
  }
}
