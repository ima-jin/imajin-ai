import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const base = 'px-4 py-2 rounded font-medium transition-colors';
  const variants = {
    primary: 'bg-orange-500 text-white hover:bg-orange-600',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
