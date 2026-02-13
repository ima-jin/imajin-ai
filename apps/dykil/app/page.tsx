import { SpendingForm } from '@/src/components/SpendingForm';

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto pt-12 pb-8 px-6">
        <h1 className="text-5xl font-bold mb-4 text-center">
          Don't You Know I'm <span className="text-orange-500">Local</span>?
        </h1>
        <p className="text-xl text-gray-400 mb-2 max-w-2xl mx-auto text-center">
          Track where your community's money goes. Keep it home.
        </p>
        <p className="text-sm text-gray-500 mb-12 max-w-xl mx-auto text-center">
          See how much your neighborhood sends to Silicon Valley every month — 
          and what it could look like if we kept it local.
        </p>
      </div>
      
      <SpendingForm />
      
      <footer className="mt-16 pb-8 text-center text-gray-600 text-sm">
        <p>No signup required. Your data stays anonymous.</p>
        <p className="mt-2">
          A project by{' '}
          <a href="https://imajin.ai" className="text-orange-500 hover:text-orange-400">
            Imajin
          </a>
        </p>
      </footer>
    </main>
  );
}
