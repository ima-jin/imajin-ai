'use client';

import { useState, useRef, useEffect } from 'react';

interface SignupFormProps {
  eventSlug: string;
  onSignup: () => void;
  formRef?: React.RefObject<HTMLFormElement>;
}

export function SignupForm({ eventSlug, onSignup, formRef }: SignupFormProps) {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/events/${eventSlug}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });

      if (res.ok) {
        setName('');
        setShowSuccess(true);
        onSignup();
        
        // Hide success after animation and scroll to top
        setTimeout(() => {
          setShowSuccess(false);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 1500);
      }
    } catch (error) {
      console.error('Signup failed:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Focus input when form is scrolled to
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          inputRef.current?.focus();
        }
      },
      { threshold: 0.5 }
    );

    if (inputRef.current) {
      observer.observe(inputRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="p-4 bg-gray-800 border-t border-gray-700">
      {showSuccess ? (
        <div className="flex items-center justify-center py-4 text-green-400 text-xl animate-bounce">
          ✓ You&apos;re signed up!
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            className="flex-1 px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
            disabled={isSubmitting}
          />
          <button
            type="submit"
            disabled={isSubmitting || !name.trim()}
            className="px-6 py-3 bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? '...' : 'Sign Up'}
          </button>
        </div>
      )}
    </form>
  );
}
