'use client';

import { useRouter } from 'next/navigation';
import BumpConnect from '../connections/bump/BumpConnect';

export default function BumpPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <BumpConnect onClose={() => router.push('/connections')} />
    </div>
  );
}
