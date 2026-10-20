import { notFound } from 'next/navigation';
import AgreementPreview from './agreement-preview';

export default function AgreementPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <AgreementPreview />;
}
