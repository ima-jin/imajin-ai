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
  const page = await getCoffeePage(params.handle);
  
  if (!page) {
    notFound();
  }

  const theme = page.theme || {};
  const bgColor = theme.backgroundColor || '#fffbeb';
  const primaryColor = theme.primaryColor || '#f59e0b';

  return (
    <div 
      className="max-w-lg mx-auto"
      style={{ 
        '--primary-color': primaryColor,
        '--bg-color': bgColor,
      } as React.CSSProperties}
    >
      <div 
        className="rounded-2xl shadow-xl p-8 text-center"
        style={{ backgroundColor: bgColor }}
      >
        {/* Avatar */}
        <div className="mb-4">
          {page.avatar?.startsWith('http') ? (
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

        {/* Tip Form */}
        <TipForm 
          page={page} 
          primaryColor={primaryColor}
        />
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-gray-400 mt-4">
        Powered by <a href="https://imajin.ai" className="hover:underline">Imajin</a>
        {' · '}
        No platform fees
      </p>
    </div>
  );
}
