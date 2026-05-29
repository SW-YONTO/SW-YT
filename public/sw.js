// SW-YTify PWA Service Worker
const CACHE_NAME = 'sw-ytify-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/style.css',
  '/main.js',
  '/favicon.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;600;800&display=swap',
  'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfMZhrib2BgA.woff2',
  'https://fonts.gstatic.com/s/outfit/v11/Fana80pqn1Y277Op8J0pVblD2cSc2178yQ.woff2',
  'https://unpkg.com/lucide@latest'
];

// Install Event: Pre-cache Static Assets (App Shell)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching App Shell assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch Event: Implement Network-First and Cache-First caching strategies
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // CRITICAL BYPASS: Strictly ignore all API endpoints under `/api/*`
  // Caching these would break live downloads, progress SSE, and status endpoints.
  if (requestUrl.pathname.startsWith('/api/')) {
    return; // Pass-through to network, do not intercept
  }

  // Bypass non-GET requests (e.g. POST for download initiation)
  if (event.request.method !== 'GET') {
    return;
  }

  // Strategy 1: Cache-First for static external assets (fonts, icons, CDN libraries)
  if (
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.endsWith('.png') ||
    requestUrl.pathname.endsWith('.woff2')
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }

          // Cache the fetched asset for future offline use
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });

          return networkResponse;
        }).catch(() => {
          // Silent fallback on external network failure
        });
      })
    );
    return;
  }

  // Strategy 2: Network-First with Cache Fallback for Root page & App code (CSS, JS)
  // Ensures user always gets live changes while online, but preserves offline access.
  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      // If response is valid, cache/update it
      if (networkResponse && networkResponse.status === 200) {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Normalize URL query params for EJS view builds (ignore ?v= build version key for caching)
          const cacheRequest = requestUrl.pathname === '/' 
            ? new Request('/') 
            : event.request;
          cache.put(cacheRequest, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      console.log('[Service Worker] Network request failed. Serving from cache fallback:', event.request.url);
      
      // Attempt cache match
      const cacheRequest = requestUrl.pathname === '/' 
        ? new Request('/') 
        : event.request;

      return caches.match(cacheRequest).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Offline Fallback HTML response when nothing is cached
        if (event.request.headers.get('accept').includes('text/html')) {
          return new Response(
            `<!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Offline | SW-YTify</title>
              <style>
                body {
                  background-color: #0a0b10;
                  color: #ffffff;
                  font-family: system-ui, sans-serif;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                  text-align: center;
                }
                h1 { margin-bottom: 8px; font-weight: 800; color: #00f2fe; }
                p { color: #9499b3; max-width: 400px; margin-bottom: 20px; line-height: 1.6; }
                .btn {
                  background: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%);
                  color: #000;
                  padding: 10px 20px;
                  border-radius: 8px;
                  text-decoration: none;
                  font-weight: 600;
                }
              </style>
            </head>
            <body>
              <h1>You are Offline</h1>
              <p>SW-YTify requires an active internet connection to download and extract video files. Please check your network connection and try again.</p>
              <a href="/" class="btn">Retry Connection</a>
            </body>
            </html>`,
            {
              headers: { 'Content-Type': 'text/html' }
            }
          );
        }
      });
    })
  );
});
