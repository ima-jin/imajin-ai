import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ handle: string }>;
}

export default async function OldProfileRedirect({ params }: Props) {
  const { handle } = await params;
  redirect(`/p/${handle}`);
}
