import { redirect } from 'next/navigation';
import { getEffectiveDid } from '../lib/get-effective-did';
import ServiceEmbed from '../components/ServiceEmbed';

export default async function EventsPage() {
  const { effectiveDid } = await getEffectiveDid();
  if (!effectiveDid) {
    redirect('/auth/login');
  }
  return <ServiceEmbed service="events" did={effectiveDid} />;
}
