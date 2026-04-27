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
    <div className="mb-6 bg-surface-surface/50 border border-white/10 p-4">
      <p className="text-xs text-secondary mb-3 text-center">Services</p>
      <div className="flex flex-wrap justify-center gap-2">
        {services.map((svc) => (
          <a
            key={svc.name}
            href={handle ? `${buildServiceUrl(svc.name)}/${handle}` : buildServiceUrl(svc.name)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-elevated border border-white/10 hover:bg-surface-elevated transition text-sm text-primary"
          >
            <span>{svc.icon}</span>
            <span>{svc.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
