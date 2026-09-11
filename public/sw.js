// オフラインでも「カード登録」画面が開けるようにするための最小限のService Worker。
// 一覧・デッキ・戦績など他の画面はキャッシュ対象外（今まで通りWi-Fi前提）。
const CACHE_NAME = 'mushijingi-offline-v1';
const PRECACHE_URLS = [
  '/cards/new',
  '/css/style.css',
  '/js/voice.js',
  '/js/offline.js',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // 登録の送信(POST)はここでは扱わない。offline.js側で処理する

  const isRegisterPage = request.url.includes('/cards/new');

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      // カード登録画面は「まずキャッシュを即返す→裏で最新に更新」。オフラインでも必ず開けることを優先
      if (isRegisterPage) {
        return cached || networkFetch;
      }
      return networkFetch;
    })
  );
});
