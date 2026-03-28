export async function send(params: {
  to: string;
  scope: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  urgency?: "low" | "normal" | "urgent";
}): Promise<void> {
  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!notifyUrl || !secret) {
    console.warn("Notification skipped: NOTIFY_SERVICE_URL or NOTIFY_WEBHOOK_SECRET not set");
    return;
  }
  try {
    const res = await fetch(`${notifyUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Notification (${params.scope}) failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`Notification (${params.scope}) error:`, err);
  }
}

export const notify = { send };
