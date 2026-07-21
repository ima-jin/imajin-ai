import { redirect } from 'next/navigation';
import { getSession , resolveActingDid } from '@imajin/auth';
import { buildPublicUrl } from '@imajin/config';
import EventCreateForm from './form';

export default async function CreateEventPage() {
  const session = await getSession();
  
  if (!session) {
    // Redirect to auth with return URL
    const authUrl = buildPublicUrl('auth');
    const eventsUrl = buildPublicUrl('events');
    const createUrl = `${eventsUrl}/create`;
    redirect(`${authUrl}/login?next=${encodeURIComponent(createUrl)}`);
  }

  const did = resolveActingDid(session);

  return (
    <div className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Create Event</h1>
          <p className="text-gray-500 dark:text-gray-400">
            Bring people together with Imajin Events
          </p>
        </div>

        <EventCreateForm organizerDid={did} />
      </div>
    </div>
  );
}
