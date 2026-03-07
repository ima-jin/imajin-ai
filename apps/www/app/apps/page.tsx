import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Apps — Imajin',
  description: 'Explore the Imajin app ecosystem.',
};

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

interface ServiceEntry {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: string;
  category: string;
  url: string;
}

async function getServices(): Promise<ServiceEntry[]> {
  try {
    const registryPrefix = PREFIX.replace(/^https?:\/\//, '').replace(/-$/, '');
    const subdomain = registryPrefix ? `${registryPrefix}-registry` : 'registry';
    const registryUrl = `https://${subdomain}.${DOMAIN}`;
    
    const res = await fetch(`${registryUrl}/api/specs`, {
      next: { revalidate: 900 }, // 15 min ISR
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.services || [];
  } catch {
    return [];
  }
}

function ServiceCard({ service }: { service: ServiceEntry }) {
  return (
    <a
      href={service.url}
      className="group block p-5 rounded-xl border border-gray-200 dark:border-gray-800 hover:border-orange-400 dark:hover:border-orange-600 bg-white dark:bg-gray-900 hover:shadow-lg transition-all no-underline"
    >
      <div className="flex items-start gap-4">
        <span className="text-3xl flex-shrink-0 mt-0.5">{service.icon}</span>
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white group-hover:text-orange-500 dark:group-hover:text-orange-400 transition">
            {service.label}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
            {service.description}
          </p>
        </div>
      </div>
    </a>
  );
}

export default async function AppsPage() {
  const services = await getServices();

  const publicApps = services.filter((s) => s.visibility === 'public');
  const authenticatedApps = services.filter((s) => s.visibility === 'authenticated');
  const creatorApps = services.filter((s) => s.visibility === 'creator');

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-black">
      <div className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            🚀 Apps
          </h1>
          <p className="text-lg text-gray-500 dark:text-gray-400">
            Explore the Imajin ecosystem
          </p>
        </div>

        {publicApps.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-4 px-1">
              Explore
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {publicApps.map((s) => (
                <ServiceCard key={s.name} service={s} />
              ))}
            </div>
          </section>
        )}

        {authenticatedApps.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-4 px-1">
              Your Network
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {authenticatedApps.map((s) => (
                <ServiceCard key={s.name} service={s} />
              ))}
            </div>
          </section>
        )}

        {creatorApps.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-4 px-1">
              Creator Tools
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {creatorApps.map((s) => (
                <ServiceCard key={s.name} service={s} />
              ))}
            </div>
          </section>
        )}

        {services.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <p>Unable to load apps. Please try again later.</p>
          </div>
        )}
      </div>
    </main>
  );
}
