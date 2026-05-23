import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ eventId: string; ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OldRegisterRedirect({ params, searchParams }: Props) {
  const { eventId, ticketId } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') qs.set(key, value);
    else if (Array.isArray(value)) value.forEach(v => qs.append(key, v));
  }
  const query = qs.toString();
  redirect(`/e/${eventId}/register/${ticketId}${query ? `?${query}` : ''}`);
}
