export function getActingAs(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('imajin:acting-as');
}

export function setActingAs(did: string | null): void {
  if (typeof window === 'undefined') return;
  if (did) {
    localStorage.setItem('imajin:acting-as', did);
    document.cookie = `x-acting-as=${did}; path=/; max-age=31536000; SameSite=Lax`;
  } else {
    localStorage.removeItem('imajin:acting-as');
    document.cookie = 'x-acting-as=; path=/; max-age=0';
  }
  window.dispatchEvent(new CustomEvent('imajin:acting-as-changed', { detail: { did } }));
}

export function getActingAsHeaders(): Record<string, string> {
  const did = getActingAs();
  return did ? { 'X-Acting-As': did } : {};
}
