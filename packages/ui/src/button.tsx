import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const base = 'px-4 py-2 font-mono font-medium transition-colors';
  const variants = {
    primary: 'text-primary hover:brightness-110',
    secondary: 'bg-surface-elevated text-primary border border-white/[0.15] hover:bg-surface-surface',
  };
  const style = variant === 'primary' ? { background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' } : undefined;
  return <button className={`${base} ${variants[variant]} ${className}`} style={style} {...props} />;
}
