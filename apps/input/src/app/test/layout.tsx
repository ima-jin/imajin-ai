// Force dynamic rendering — no static cache for test pages
export const dynamic = 'force-dynamic';

export default function TestLayout({ children }: { children: React.ReactNode }) {
  return children;
}
