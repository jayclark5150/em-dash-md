const CACHE = 'em-dash-md-v19';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/tree-utils.js',
  '/styles.css',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js',
  'https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css',
  'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js',
  // Firebase SDK: without these the PWA cannot start offline (C-14, v3.29.0).
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Only these origins may be written into the runtime cache. This prevents the
// service worker from persisting arbitrary cross-origin responses (cache poisoning).
const CACHEABLE_ORIGINS = [
  self.location.origin,
  'https://cdn.jsdelivr.net',
  'https://www.gstatic.com',
];

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Never intercept Firebase auth redirects or Firestore/API calls.
  if (url.hostname.includes('firebaseapp.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.pathname.includes('/__/auth/')) return;

  // For HTML navigation requests go network-first so Firebase redirect
  // results are always fresh. Fall back to cache only when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // C-14: same-origin files (app.js, styles.css, ...) are network-first with
  // revalidation, so a fresh index.html can never run against a stale app.js.
  // The cache is only the offline fallback. Versioned CDN files stay cache-first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok &&
            response.type !== 'opaque' &&
            CACHEABLE_ORIGINS.includes(url.origin)) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
