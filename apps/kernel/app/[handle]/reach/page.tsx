import { notFound } from 'next/navigation';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';
import { ReachPage } from '@/src/components/reach/reach-page';

export const dynamic = 'force-dynamic';

export default async function PublicReachPage({
  params,
}: Readonly<{
  params: Promise<{ handle: string }>;
}>) {
  const { handle } = await params;
  const card = await resolveReachDiscovery(handle);
  if (!card) notFound();
  return <ReachPage card={card} />;
}
