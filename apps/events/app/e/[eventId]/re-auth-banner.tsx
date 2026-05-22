import { MagicLinkButton } from './magic-link-button';
import { ReAuthBannerShell } from '../../components/ReAuthBannerShell';

interface ReAuthBannerProps {
  eventId: string;
}

export function ReAuthBanner({ eventId }: Readonly<ReAuthBannerProps>) {

  return (
    <ReAuthBannerShell>
      <MagicLinkButton eventId={eventId} />
    </ReAuthBannerShell>
  );
}
