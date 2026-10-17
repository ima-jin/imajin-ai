import { SERVICES } from '@imajin/config';
import { buildServiceUrl } from '../lib/profile-utils';
import { resolveRegistryAppsBySlug } from '@/src/lib/kernel/app-nav';
import { registryAppBaseUrl, registryAppPublicUrl } from '@/src/lib/apps/public-url';

interface ForestServicesProps {
  enabledServices: string[];
  handle?: string;
}

export async function ForestServices({ enabledServices, handle }: Readonly<ForestServicesProps>) {
  if (!enabledServices || enabledServices.length === 0) return null;

  const apps = await resolveRegistryAppsBySlug(enabledServices);
  const services = [
    ...SERVICES.filter((s) => s.category === 'kernel' && s.visibility !== 'internal' && enabledServices.includes(s.name))
      .map((s) => ({ name: s.name, label: s.label, icon: s.icon, url: buildServiceUrl(s.name), base: buildServiceUrl(s.name) })),
    ...apps.map((app) => ({
      name: app.slug, label: app.name, icon: app.icon,
      url: registryAppPublicUrl(app), base: registryAppBaseUrl(app),
    })),
  ];

  if (services.length === 0) return null;

  return (
    <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-500 mb-3 text-center">Services</p>
      <div className="flex flex-wrap justify-center gap-2">
        {services.map((svc) => (
          <a
            key={svc.name}
            href={handle && svc.base ? `${svc.base.replace(/\/$/, '')}/${encodeURIComponent(handle)}` : svc.url}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition text-sm text-white"
          >
            <span>{svc.icon}</span>
            <span>{svc.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
