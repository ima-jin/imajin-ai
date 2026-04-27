interface ContactCardProps {
  contactEmail?: string;
  phone?: string;
}

export function ContactCard({ contactEmail, phone }: ContactCardProps) {
  if (!contactEmail && !phone) return null;

  return (
    <div className="mb-6 bg-surface-surface/50 border border-white/10 p-4 text-left">
      <p className="text-xs text-secondary mb-2 text-center">📇 Contact</p>
      {contactEmail && (
        <p className="text-sm text-primary mb-1">
          <span className="text-secondary">✉️</span>{' '}
          <a href={`mailto:${contactEmail}`} className="text-[#F59E0B] hover:underline">
            {contactEmail}
          </a>
        </p>
      )}
      {phone && (
        <p className="text-sm text-primary">
          <span className="text-secondary">📱</span>{' '}
          <a href={`tel:${phone}`} className="text-[#F59E0B] hover:underline">
            {phone}
          </a>
        </p>
      )}
    </div>
  );
}
