import { redirect } from 'next/navigation';
import { buildQueryString } from '../../preserve-query';

interface Props {
  params: Promise<{ eventId: string; ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OldRegisterRedirect({ params, searchParams }: Props) {
  const { eventId, ticketId } = await params;
  const sp = await searchParams;
  redirect(`/e/${eventId}/register/${ticketId}${buildQueryString(sp)}`);
}
