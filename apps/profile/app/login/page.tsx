'use client';

import { Suspense } from 'react';
import LoginForm from './LoginForm';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="text-center text-gray-400 mt-20">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
