import { notFound } from 'next/navigation';
import AppSecretsPreview from './app-secrets-preview';

export default function AppSecretsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <AppSecretsPreview />;
}
