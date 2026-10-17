import { notFound } from 'next/navigation';
import { RunsPreview } from './runs-preview';

export default function RunsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <RunsPreview />;
}
