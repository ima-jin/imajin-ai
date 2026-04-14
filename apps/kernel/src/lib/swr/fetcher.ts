export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const error = new Error('Fetch failed');
    (error as any).status = res.status;
    throw error;
  }
  return res.json();
}
