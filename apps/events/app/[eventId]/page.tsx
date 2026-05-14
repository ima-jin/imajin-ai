import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ eventId: string }>;
}

export default async function OldEventRedirect({ params }: Props) {
  const { eventId } = await params;
  redirect(`/e/${eventId}`);
}
