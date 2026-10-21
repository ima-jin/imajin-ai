import { notFound } from 'next/navigation';
import GrantsPreview from './grants-preview';

export default function GrantsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <GrantsPreview />;
}
