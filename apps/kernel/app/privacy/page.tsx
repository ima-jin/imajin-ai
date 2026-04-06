import Link from 'next/link';

export const metadata = {
  title: 'Privacy — Imajin',
  description: 'How Imajin handles your data. Short version: we don\'t sell it.',
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-amber-500 hover:underline mb-8 block">← Home</Link>

        <h1 className="text-4xl font-bold tracking-tight mb-2">Privacy</h1>
        <p className="text-gray-500 mb-12">Last updated: March 11, 2026</p>

        <div className="prose prose-lg dark:prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-bold mb-4">We only ask for your email when you need it.</h2>
            <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
              If you enroll in a course, RSVP to an event, or purchase a ticket, we ask for your email so you can
              access what you signed up for. That&apos;s the only reason we collect it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">What we don&apos;t do</h2>
            <ul className="space-y-2 text-gray-600 dark:text-gray-400">
              <li className="flex gap-3">
                <span className="text-gray-400 shrink-0">✕</span>
                <span>Sell or share your email with anyone</span>
              </li>
              <li className="flex gap-3">
                <span className="text-gray-400 shrink-0">✕</span>
                <span>Send marketing emails or newsletters</span>
              </li>
              <li className="flex gap-3">
                <span className="text-gray-400 shrink-0">✕</span>
                <span>Run advertising or behavioral targeting</span>
              </li>
              <li className="flex gap-3">
                <span className="text-gray-400 shrink-0">✕</span>
                <span>Track you across other websites</span>
              </li>
              <li className="flex gap-3">
                <span className="text-gray-400 shrink-0">✕</span>
                <span>Use your data to train AI models</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">What we use your email for</h2>
            <ul className="space-y-2 text-gray-600 dark:text-gray-400">
              <li className="flex gap-3">
                <span className="text-amber-500 shrink-0">→</span>
                <span>Letting you access courses and events you signed up for</span>
              </li>
              <li className="flex gap-3">
                <span className="text-amber-500 shrink-0">→</span>
                <span>Sending you a ticket or receipt if you bought something</span>
              </li>
              <li className="flex gap-3">
                <span className="text-amber-500 shrink-0">→</span>
                <span>That&apos;s it</span>
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Where your data lives</h2>
            <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
              Imajin is self-hosted on hardware we own in Toronto, Canada. Your data doesn&apos;t live
              on AWS or Google Cloud. We use Stripe for payment processing — they have their own{' '}
              <a href="https://stripe.com/privacy" className="text-amber-500 hover:underline" target="_blank" rel="noopener noreferrer">
                privacy policy
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Your rights</h2>
            <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
              Want your data deleted? Email{' '}
              <a href="mailto:privacy@imajin.ai" className="text-amber-500 hover:underline">
                privacy@imajin.ai
              </a>{' '}
              and we&apos;ll take care of it.
            </p>
          </section>

          <section className="border-t border-gray-200 dark:border-gray-800 pt-8">
            <p className="text-gray-500 text-sm leading-relaxed">
              This policy reflects how we actually operate, not how lawyers told us to write it.
              If something changes, we&apos;ll update this page and note the date.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
