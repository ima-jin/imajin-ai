import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ eventId: string; ticketId: string }>;
}

export default async function OldRegisterRedirect({ params }: Props) {
  const { eventId, ticketId } = await params;
  redirect(`/e/${eventId}/register/${ticketId}`);
}
