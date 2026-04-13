import { SERVICES } from '@imajin/config';
import { buildServiceUrl } from '../lib/profile-utils';

interface ForestServicesProps {
  enabledServices: string[];
  handle?: string;
}

export function ForestServices({ enabledServices, handle }: ForestServicesProps) {
  if (!enabledServices || enabledServices.length === 0) return null;

  const services = enabledServices
    .map((name) => SERVICES.find((s) => s.name === name))
    .filter(Boolean) as typeof SERVICES[number][];

  if (services.length === 0) return null;

  return (
    <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-500 mb-3 text-center">Services</p>
      <div className="flex flex-wrap justify-center gap-2">
        {services.map((svc) => (
          <a
            key={svc.name}
            href={handle ? `${buildServiceUrl(svc.name)}/${handle}` : buildServiceUrl(svc.name)}
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
