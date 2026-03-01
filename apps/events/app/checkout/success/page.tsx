import Link from 'next/link';

interface Props {
  searchParams: { session_id?: string };
}

export default async function SuccessPage({ searchParams }: Props) {
  const sessionId = searchParams.session_id;
  
  // In production, we'd verify the session with Stripe and create the ticket
  // For now, just show a success message
  
  return (
    <div className="max-w-2xl mx-auto text-center py-16">
      <div className="text-8xl mb-6">🎉</div>
      
      <h1 className="text-4xl font-bold mb-4">You're in!</h1>
      
      <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
        Your ticket has been confirmed. Check your email for details.
      </p>
      
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 mb-8">
        <h2 className="font-semibold text-lg mb-2">What's next?</h2>
        <ul className="text-left text-gray-600 dark:text-gray-400 space-y-2">
          <li>✓ Confirmation email sent</li>
          <li>✓ Ticket added to your wallet (coming soon)</li>
          <li>✓ Calendar invite included</li>
        </ul>
      </div>
      
      {sessionId && (
        <p className="text-sm text-gray-500 mb-4">
          Order reference: {sessionId.slice(0, 20)}...
        </p>
      )}
      
      <Link
        href="/"
        className="inline-block px-8 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-semibold"
      >
        Browse More Events
      </Link>
    </div>
  );
}
