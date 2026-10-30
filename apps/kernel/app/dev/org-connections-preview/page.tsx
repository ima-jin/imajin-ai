import { notFound } from 'next/navigation';
import OrgConnectionsPreview from './preview';

export default function OrgConnectionsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <OrgConnectionsPreview />;
}
