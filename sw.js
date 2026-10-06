// Service worker : met en cache les fichiers de l'app pour qu'elle
// fonctionne hors ligne, et rend l'app installable ("Ajouter à l'écran
// d'accueil"). Ne touche jamais aux données (elles vivent dans localStorage,
// pas ici).

const CACHE_VERSION = 'v16';
const CACHE_NAME = `planificateur-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/models.js',
  './js/scheduler.js',
  './js/colleChapters.js',
  './js/notifications.js',
  './js/stats.js',
  './js/ankiConnect.js',
  './js/travel.js',
  './js/utils/date.js',
  './js/views/dayView.js',
  './js/views/weekView.js',
  './js/views/taskFormView.js',
  './js/views/taskListView.js',
  './js/views/settingsView.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

// Tapoter une notification ramène au premier plan un onglet déjà ouvert de
// l'app, ou en ouvre un nouveau sinon.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Stratégie : RÉSEAU D'ABORD, cache en secours. Avec "cache d'abord", une
// mise à jour déployée n'apparaissait qu'après plusieurs fermetures/
// réouvertures de l'app (le téléphone resservait l'ancienne version). Ici, dès
// qu'on est en ligne on récupère toujours la dernière version (et on met le
// cache à jour au passage) ; hors ligne, on retombe sur la dernière copie
// connue — l'app reste donc utilisable sans réseau.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
