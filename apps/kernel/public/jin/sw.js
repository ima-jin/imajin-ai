// Service worker for the /jin PWA (#2291 — phone push path).
//
// Served as a static file from this exact path so its default scope is
// `/jin/` (a service worker's scope defaults to the directory containing
// the script) — no `Service-Worker-Allowed` header or app/ route needed.
// Two jobs only:
//   1. Receive a Web Push (VAPID) message (apps/kernel/src/lib/notify/
//      web-push.ts) and show a notification.
//   2. On tap, open the deep link the push carried (payload.url, e.g.
//      `/jin?proposalId=...`) straight to the confirm-card queue.
// No caching/offline strategy — installable-PWA scope only for #2291. A
// fetch handler is intentionally omitted: it is not required for
// installability, and an empty passthrough would add no real behavior.

globalThis.addEventListener('install', () => {
  globalThis.skipWaiting();
});

globalThis.addEventListener('activate', (event) => {
  event.waitUntil(globalThis.clients.claim());
});

globalThis.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'imajin';
  const url = payload.url || '/jin';
  event.waitUntil(
    globalThis.registration.showNotification(title, {
      body: payload.body || '',
      data: { url },
      tag: url,
    }),
  );
});

globalThis.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/jin';
  event.waitUntil(globalThis.clients.openWindow(url));
});
