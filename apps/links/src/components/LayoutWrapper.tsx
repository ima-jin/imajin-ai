import { getSession } from '@/lib/auth';
import { SubNav } from './SubNav';

export async function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <>
      <SubNav isAuthenticated={!!session} />
      {children}
    </>
  );
}
