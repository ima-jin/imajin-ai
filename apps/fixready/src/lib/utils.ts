import { nanoid } from 'nanoid';
import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function generateId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

export function generateToken(): string {
  return nanoid(10);
}
