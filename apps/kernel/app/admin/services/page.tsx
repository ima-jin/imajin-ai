import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import ServicesRefresh from './refresh';

interface ServiceHealth {
  name: string;
  label: string;
  group: 'kernel' | 'userspace';
  status: 'healthy' | 'degraded' | 'down';
  responseTime: number | null;
  version?: string;
  build?: string;
  checkedAt: string;
}

async function fetchHealth(): Promise<{ services: ServiceHealth[]; checkedAt: string } | null> {
  const port = process.env.PORT ?? '7000';
  try {
    const res = await fetch(`http://localhost:${port}/api/admin/services/health`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function AdminServicesPage() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/');

  const data = await fetchHealth();

  const kernelServices = data?.services.filter((s) => s.group === 'kernel') ?? [];
  const userspaceServices = data?.services.filter((s) => s.group === 'userspace') ?? [];

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Services</h1>
          <p className="mt-1 text-sm text-secondary dark:text-secondary">
            {data
              ? `Last checked ${new Date(data.checkedAt).toLocaleTimeString()}`
              : 'Health check unavailable'}
          </p>
        </div>
        <ServicesRefresh />
      </div>

      {!data ? (
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-8 text-center">
          <p className="text-secondary dark:text-secondary text-sm">
            Could not fetch service health. Check admin authentication.
          </p>
        </div>
      ) : (
        <>
          <ServiceSection title="Kernel Services" services={kernelServices} />
          <ServiceSection title="Userspace Services" services={userspaceServices} />
        </>
      )}
    </div>
  );
}

function ServiceSection({
  title,
  services,
}: {
  title: string;
  services: ServiceHealth[];
}) {
  if (services.length === 0) return null;

  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const total = services.length;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-primary uppercase tracking-wide font-mono">
          {title}
        </h2>
        <span className="text-xs text-secondary dark:text-secondary">
          {healthyCount}/{total} healthy
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {services.map((svc) => (
          <ServiceCard key={svc.name} service={svc} />
        ))}
      </div>
    </div>
  );
}

function ServiceCard({ service }: { service: ServiceHealth }) {
  const statusConfig = {
    healthy: {
      indicator: '🟢',
      label: 'Healthy',
      textClass: 'text-success dark:text-success',
      bgClass: 'bg-success/10 dark:bg-success/20',
    },
    degraded: {
      indicator: '🟡',
      label: 'Degraded',
      textClass: 'text-warning dark:text-warning',
      bgClass: 'bg-yellow-50 dark:bg-warning/20/20',
    },
    down: {
      indicator: '🔴',
      label: 'Down',
      textClass: 'text-error dark:text-error',
      bgClass: 'bg-error/10 dark:bg-error/20',
    },
  };

  const config = statusConfig[service.status];

  return (
    <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-primary text-sm font-mono">{service.label}</h3>
          <span className="text-xs text-secondary dark:text-secondary capitalize">{service.name}</span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 font-medium ${config.bgClass} ${config.textClass}`}
        >
          {service.group === 'kernel' ? 'Kernel' : 'Userspace'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-base leading-none">{config.indicator}</span>
        <span className={`text-sm font-medium ${config.textClass}`}>{config.label}</span>
        {service.responseTime !== null && (
          <span className="ml-auto text-xs text-secondary dark:text-secondary">
            {service.responseTime}ms
          </span>
        )}
      </div>

      {service.version && (
        <p className="mt-2 text-xs text-secondary dark:text-secondary font-mono">
          v{service.version}
          {service.build && service.build !== 'dev' ? ` (${service.build.slice(0, 7)})` : ''}
        </p>
      )}
    </div>
  );
}
