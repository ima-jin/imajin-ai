import { notFound } from 'next/navigation';
import LinkButton from './link-button';

interface PageProps {
  params: { handle: string };
}

interface Link {
  id: string;
  title: string;
  url: string;
  icon?: string;
  thumbnail?: string;
  clicks: number;
}

interface Theme {
  backgroundColor?: string;
  textColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  buttonStyle?: 'rounded' | 'square' | 'pill';
}

async function getLinksPage(handle: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3010';
  
  try {
    const response = await fetch(`${baseUrl}/api/pages/${handle}`, {
      cache: 'no-store',
    });
    
    if (!response.ok) {
      return null;
    }
    
    return response.json();
  } catch (error) {
    console.error('Failed to fetch links page:', error);
    return null;
  }
}

export default async function LinksPage({ params }: PageProps) {
  const page = await getLinksPage(params.handle);
  
  if (!page) {
    notFound();
  }

  const theme: Theme = page.theme || {};
  const bgColor = theme.backgroundColor || '#1a1a1a';
  const textColor = theme.textColor || '#ffffff';
  const buttonColor = theme.buttonColor || '#ff8c00';
  const buttonTextColor = theme.buttonTextColor || '#000000';
  const buttonStyle = theme.buttonStyle || 'pill';

  const borderRadius = {
    rounded: '0.75rem',
    square: '0.25rem',
    pill: '9999px',
  }[buttonStyle];

  return (
    <div 
      className="min-h-screen py-12 px-4"
      style={{ 
        backgroundColor: bgColor,
        color: textColor,
      }}
    >
      <div className="max-w-lg mx-auto">
        {/* Avatar */}
        <div className="text-center mb-6">
          {page.avatar?.startsWith('http') ? (
            <img 
              src={page.avatar} 
              alt={page.title}
              className="w-24 h-24 rounded-full mx-auto object-cover mb-4"
            />
          ) : (
            <div 
              className="w-24 h-24 rounded-full mx-auto flex items-center justify-center text-4xl mb-4"
              style={{ backgroundColor: buttonColor + '30' }}
            >
              {page.avatar || '🔗'}
            </div>
          )}

          {/* Title */}
          <h1 className="text-2xl font-bold mb-2">{page.title}</h1>
          
          {/* Bio */}
          {page.bio && (
            <p className="opacity-80 mb-6">{page.bio}</p>
          )}
        </div>

        {/* Links */}
        <div className="space-y-3">
          {page.links?.map((link: Link) => (
            <LinkButton
              key={link.id}
              link={link}
              buttonColor={buttonColor}
              buttonTextColor={buttonTextColor}
              borderRadius={borderRadius}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="mt-12 text-center opacity-50 text-sm">
          <a 
            href="https://links.imajin.ai" 
            className="hover:opacity-100 transition"
          >
            ⚡ Powered by Imajin
          </a>
        </div>
      </div>
    </div>
  );
}
