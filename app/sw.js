/* 药准时 · Service Worker
 * 作用：① 静态资源离线缓存 ② 接收家属端的 Web Push（页面关闭时也能弹通知）。
 * 注意：这是静态缓存 SW + 推送接收端，**不承担后台唤醒提醒的职责**。
 * 后台准时提醒由 platform.js 交给系统级闹钟（原生容器下）。
 */
const CACHE = 'mediontime-v4';

/* 只列真实存在的文件。
 * 原先还列了 './'（目录根），但不少静态服务器不提供目录索引 → 404，
 * 而 cache.addAll() 是原子的：一个失败会让整个 install 事件 reject，
 * SW 直接装不上，离线能力全废。故去掉，并改为逐个容错缓存。 */
const ASSETS = [
  './index.html',
  './caregiver.html',
  './css/style.css',
  './js/scheduler.js',
  './js/platform.js',
  './js/store.js',
  './js/relay.js',
  './js/reminder.js',
  './js/app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((url) =>
        // 注意：这里必须用【全局 fetch】。Cache 接口只有
        // add/addAll/delete/keys/match/matchAll/put，没有 fetch()，
        // 误写成 c.fetch() 会让 install 事件直接抛错、SW 永远停在 installing。
        fetch(url, { cache: 'reload' })
          .then((res) => (res && res.ok ? c.put(url, res) : null))
          .catch(() => null) // 单个资源缺失不能拖垮整体安装
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 只接管同源静态资源，避免误缓存第三方响应
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch { sameOrigin = false; }
  if (!sameOrigin) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.match('./index.html').then((idx) => idx || Response.error())
      );
    })
  );
});

/* ------------------------------------------------------------------
 * 家属端 Web Push
 *
 * 这一段只在「家属」那台设备上起作用（家属在 caregiver.html 里登记了订阅）。
 * 患者端的应用不会收到推送——患者端根本不订阅。
 *
 * 为什么必须有它：家属不可能一直把页面开着。
 * SSE 只在页面打开时有效，而"漏服"这种事恰恰最可能发生在深夜、家属已经睡了。
 * Web Push 由系统投递，页面关着也能响——这是"家属真的收到"与"家属开着页面才收到"的分界线。
 * ------------------------------------------------------------------ */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // 载荷不是 JSON（或解密失败）时不要静默丢弃：弹一条"有提醒但读不出来"，
    // 总好过家长什么都没看到——这与本项目"不静默失败"的一贯做法一致。
    try { data = { text: event.data ? event.data.text() : '有一条未确认的用药提醒' }; }
    catch (e2) { data = { text: '有一条未确认的用药提醒' }; }
  }

  const title = data.title || '家人有一条用药提醒未确认';
  const body = data.text || '打开查看详情';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || 'mediontime-caregiver',
      // 漏服是需要处理的事，不该自己滑走
      requireInteraction: true,
      renotify: true,
      data: { url: './caregiver.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './caregiver.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 已经开着 caregiver 页面就聚焦它，而不是再开一个
      for (const c of list) {
        if (c.url && c.url.indexOf('caregiver.html') !== -1 && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
