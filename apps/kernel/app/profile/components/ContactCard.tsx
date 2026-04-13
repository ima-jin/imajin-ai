interface ContactCardProps {
  contactEmail?: string;
  phone?: string;
}

export function ContactCard({ contactEmail, phone }: ContactCardProps) {
  if (!contactEmail && !phone) return null;

  return (
    <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-left">
      <p className="text-xs text-gray-500 mb-2 text-center">📇 Contact</p>
      {contactEmail && (
        <p className="text-sm text-gray-300 mb-1">
          <span className="text-gray-500">✉️</span>{' '}
          <a href={`mailto:${contactEmail}`} className="text-[#F59E0B] hover:underline">
            {contactEmail}
          </a>
        </p>
      )}
      {phone && (
        <p className="text-sm text-gray-300">
          <span className="text-gray-500">📱</span>{' '}
          <a href={`tel:${phone}`} className="text-[#F59E0B] hover:underline">
            {phone}
          </a>
        </p>
      )}
    </div>
  );
}
