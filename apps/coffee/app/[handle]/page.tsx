import { notFound } from 'next/navigation';
import TipForm from './tip-form';

interface PageProps {
  params: { handle: string };
}

async function getCoffeePage(handle: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3009';

  try {
    const response = await fetch(`${baseUrl}/api/pages/${handle}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (error) {
    console.error('Failed to fetch coffee page:', error);
    return null;
  }
}

export default async function CoffeePage({ params }: PageProps) {
  // Skip static file requests that leak through
  if (params.handle.includes('.') || params.handle === 'favicon') {
    notFound();
  }

  const page = await getCoffeePage(params.handle);

  if (!page) {
    notFound();
  }

  const theme = page.theme || {};
  const bgColor = theme.backgroundColor || '#fffbeb';
  const primaryColor = theme.primaryColor || '#f59e0b';

  const avatarIsImage = page.avatar && (page.avatar.startsWith('http') || page.avatar.includes('/'));

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: bgColor }}
    >
      <div
        className="max-w-lg mx-auto px-4 py-12 text-center"
        style={{ '--primary-color': primaryColor } as React.CSSProperties}
      >
        {/* Avatar */}
        <div className="mb-4">
          {avatarIsImage ? (
            <img
              src={page.avatar}
              alt={page.title}
              className="w-24 h-24 rounded-full mx-auto object-cover"
            />
          ) : (
            <div
              className="w-24 h-24 rounded-full mx-auto flex items-center justify-center text-4xl"
              style={{ backgroundColor: primaryColor + '20' }}
            >
              {page.avatar || '☕'}
            </div>
          )}
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold mb-2">{page.title}</h1>

        {/* Bio */}
        {page.bio && (
          <p className="text-gray-600 mb-6">{page.bio}</p>
        )}

        {/* A thought */}
        <div className="mb-6 bg-orange-100 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-2xl p-6 text-left">
          <h2 className="text-lg font-bold mb-3 text-orange-800 dark:text-orange-200">A thought on where your money goes</h2>
          <div className="text-orange-900 dark:text-orange-100 space-y-3 text-sm">
            <p>
              You probably spend $20/month on subscriptions you barely touch — feeding platforms
              that turn your attention into their product.
            </p>
            <p>
              What if that money went to open source projects building the alternative? Infrastructure
              owned by people, not shareholders. Tools that undo the mess instead of profiting from it.
            </p>
            <p className="font-semibold">This is that.</p>
          </div>
        </div>

        {/* Tip Form */}
        <TipForm
          page={page}
          primaryColor={primaryColor}
        />

        {/* Footer */}
        <p className="text-center text-xs text-gray-400 mt-4">
          Powered by <a href="https://imajin.ai" className="hover:underline">Imajin</a>
          {' · '}
          No platform fees
        </p>
      </div>
    </div>
  );
}
