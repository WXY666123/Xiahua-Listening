// Only this site's shell is cached. Audio uses the browser's native Range requests.
const CACHE = 'xiahua-shell-20260923b';
const ROOT = new URL('./', self.location.href);
const SHELL = [
  './', 'index.html', 'JS/player.html',
  'JS/library-manifest.js?v=20260909a', 'JS/web-library.js?v=20260923b',
  'JS/library-cache.js?v=20260910b', 'JS/audio-durations.js?v=20260910e',
  'JS/practice-tracker.js?v=20260524e', 'JS/practice-tracker.js?v=20260804a',
  'JS/auth-client.js?v=20260518b', 'JS/auth-client.js?v=20260804a',
  'JS/suite-practice.js?v=20260824f', 'JS/index-app.js?v=20260923b',
  'JS/audio-recovery.js?v=20260923b', 'JS/player-app.js?v=20260923b',
  'JS/site-cache.js?v=20260923b'
].map(path => new URL(path, ROOT).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('xiahua-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  const path = url.pathname.slice(ROOT.pathname.length);
  const home = path === '' || path === 'index.html';
  const player = path === 'JS/player.html';
  if (request.mode === 'navigate' && (home || player)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = new URL(player ? 'JS/player.html' : './', ROOT).href;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      try {
        const response = await fetch(request, {signal: controller.signal});
        if (!response.ok) throw new Error('Navigation failed: ' + response.status);
        // Keep this release's shell atomic with its precached scripts.
        return response;
      } catch (error) {
        const cached = await cache.match(key);
        if (cached) return cached;
        throw error;
      } finally { clearTimeout(timeout); }
    })());
  } else if (SHELL.includes(url.href)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
