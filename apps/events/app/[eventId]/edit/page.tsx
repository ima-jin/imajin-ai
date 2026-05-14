import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ eventId: string }>;
}

export default async function OldEventEditRedirect({ params }: Props) {
  const { eventId } = await params;
  redirect(`/e/${eventId}/edit`);
}
