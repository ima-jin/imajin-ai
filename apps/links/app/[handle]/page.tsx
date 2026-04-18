import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db, linkPages, links } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { getSession } from '@imajin/auth';
import { buildPublicUrl } from '@imajin/config';
import LinkButton from './link-button';

interface PageProps {
  params: { handle: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const page = await db.query.linkPages.findFirst({
    where: eq(linkPages.handle, params.handle),
  });

  if (!page || !page.isPublic) {
    return { title: 'Links | Imajin' };
  }

  const title = `${page.title} | Links | Imajin`;
  const description = page.bio || 'Sovereign link-in-bio page on the Imajin network';
  const url = `${buildPublicUrl('links')}/${page.handle}`;
  const avatarIsImage = page.avatar && (page.avatar.startsWith('http') || page.avatar.startsWith('/'));
  const ogImage = avatarIsImage
    ? (page.avatar!.startsWith('http') ? page.avatar! : `${buildPublicUrl('links')}${page.avatar}`)
    : null;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: 'Imajin',
      type: 'profile',
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
    other: {
      ...(ogImage && { image: ogImage }),
    },
  };
}

interface Theme {
  backgroundColor?: string;
  textColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  buttonStyle?: 'rounded' | 'square' | 'pill';
}

export default async function LinksPage({ params }: PageProps) {
  const page = await db.query.linkPages.findFirst({
    where: eq(linkPages.handle, params.handle),
  });

  if (!page || !page.isPublic) {
    notFound();
  }

  const pageLinks = await db.select().from(links)
    .where(and(eq(links.pageId, page.id), eq(links.isActive, true)))
    .orderBy(asc(links.position));

  // Get session to determine which links to show
  const session = await getSession();
  const isAuthenticated = !!session;

  // Filter links based on visibility
  const visibleLinks = pageLinks.filter((link) => {
    if (link.visibility === 'authenticated') {
      return isAuthenticated;
    }
    return true; // public links are always visible
  });

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
          {visibleLinks.map((link) => (
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
