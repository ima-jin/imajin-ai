import { NavBar } from '@imajin/ui';

export default function ChromeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

  return (
    <>
      <NavBar
        currentService="Surveys"
        servicePrefix={servicePrefix}
        domain={domain}
      />
      {children}
    </>
  );
}
