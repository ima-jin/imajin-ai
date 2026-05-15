import { redirect } from 'next/navigation';

export default function GroupSettingsRedirect({
  params,
}: {
  params: { groupDid: string };
}) {
  // Standalone group settings page has been unified into the auth hub.
  // All settings are now available at /auth/settings (with x-acting-as cookie set).
  redirect('/auth');
}
