import type { Metadata } from 'next';
import { NavBar, themeInitScript } from '@imajin/ui';
import './globals.css'; export const metadata: Metadata = { title: 'Market | Imajin', description: 'Local commerce — buy and sell with trust on the Imajin network', openGraph: { title: 'Market | Imajin', description: 'Local commerce — buy and sell with trust on the Imajin network', siteName: 'Imajin', type: 'website', }, twitter: { card: 'summary', title: 'Market | Imajin', description: 'Local commerce — buy and sell with trust on the Imajin network', },
}; export default function RootLayout({ children,
}: { children: React.ReactNode;
}) { const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'; const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'; return ( <html lang="en"> <head> <script dangerouslySetInnerHTML={{ __html: themeInitScript }} /> </head> <body className="min-h-screen bg-surface-surface bg-surface-base text-primary text-primary"> <NavBar currentService="Market" servicePrefix={servicePrefix} domain={domain} /> {children} </body> </html> );
}
