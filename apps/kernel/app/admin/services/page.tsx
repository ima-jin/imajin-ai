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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Services</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {data
              ? `Last checked ${new Date(data.checkedAt).toLocaleTimeString()}`
              : 'Health check unavailable'}
          </p>
        </div>
        <ServicesRefresh />
      </div>

      {!data ? (
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400 text-sm">
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
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          {title}
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
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
      textClass: 'text-green-700 dark:text-green-400',
      bgClass: 'bg-green-50 dark:bg-green-900/20',
    },
    degraded: {
      indicator: '🟡',
      label: 'Degraded',
      textClass: 'text-yellow-700 dark:text-yellow-400',
      bgClass: 'bg-yellow-50 dark:bg-yellow-900/20',
    },
    down: {
      indicator: '🔴',
      label: 'Down',
      textClass: 'text-red-700 dark:text-red-400',
      bgClass: 'bg-red-50 dark:bg-red-900/20',
    },
  };

  const config = statusConfig[service.status];

  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white text-sm">{service.label}</h3>
          <span className="text-xs text-gray-500 dark:text-gray-400 capitalize">{service.name}</span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${config.bgClass} ${config.textClass}`}
        >
          {service.group === 'kernel' ? 'Kernel' : 'Userspace'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-base leading-none">{config.indicator}</span>
        <span className={`text-sm font-medium ${config.textClass}`}>{config.label}</span>
        {service.responseTime !== null && (
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
            {service.responseTime}ms
          </span>
        )}
      </div>

      {service.version && (
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500 font-mono">
          v{service.version}
          {service.build && service.build !== 'dev' ? ` (${service.build.slice(0, 7)})` : ''}
        </p>
      )}
    </div>
  );
}
