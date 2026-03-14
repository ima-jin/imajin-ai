/**
 * Safe fetch wrapper for tool execute functions.
 * Returns structured error objects instead of throwing,
 * so the model always gets a result it can reason about.
 */
export async function safeFetch(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}`, detail: text.slice(0, 200) };
    }
    return await res.json();
  } catch (err: any) {
    return { error: 'fetch_failed', detail: err.message };
  }
}
