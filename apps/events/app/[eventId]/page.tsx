import { redirect } from 'next/navigation';
import { buildQueryString } from './preserve-query';

interface Props {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OldEventRedirect({ params, searchParams }: Props) {
  const { eventId } = await params;
  const sp = await searchParams;
  redirect(`/e/${eventId}${buildQueryString(sp)}`);
}
