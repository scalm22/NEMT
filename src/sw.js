const CACHE = 'vis-rides-v1';

const OFFLINE_ASSETS = [
  '/demo.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — cache core assets so the app shell loads offline
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(OFFLINE_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - App shell (HTML, icons, manifest) → cache first, fall back to network
// - API calls to backend → network only (never cache live AI responses)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API/chat calls — always go live
  if (url.pathname.startsWith('/chat') || url.pathname.startsWith('/sms') || url.pathname.startsWith('/api')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for app shell assets
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback — return cached app shell
      if (event.request.destination === 'document') {
        return caches.match('/demo.html');
      }
    })
  );
});

// Push notifications (for ride reminders — future feature)
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'VIS Rides', {
      body: data.body || 'Your ride reminder',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: 'vis-ride-reminder',
      data: { url: data.url || '/demo.html' }
    })
  );
});

// Notification click — open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/demo.html');
    })
  );
});
