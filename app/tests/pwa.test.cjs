/**
 * sw.js（Service Worker）测试
 * 运行：node tests/pwa.test.cjs
 *
 * 为什么需要它：
 *   sw.js 是唯一一段「只在浏览器里跑、纯 Node 测试碰不到」的代码。
 *   它出问题时页面照样能显示，只是离线缓存静默失效 —— 最难发现的那一类。
 *
 *   真实的坑：原实现用 caches.open(CACHE).then(c => c.addAll(ASSETS))。
 *   addAll 是【原子】的：ASSETS 里只要有一个请求不是 2xx，整个 install
 *   事件就 reject，SW 直接装不上。而 ASSETS 里恰好有 './'（目录根），
 *   不少静态服务器（含预览服务器）不提供目录索引 → 404 → 离线能力全废。
 *
 * 做法：用 node:vm 造一个假的 Service Worker 全局环境（self / caches / fetch），
 *       把 sw.js 真跑一遍，然后手动触发 install / activate / fetch 事件断言行为。
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
/** 去掉注释后的源码：注释里会提到 addAll 这个词，不能拿来当代码断言 */
const SRC_CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const ORIGIN = 'http://localhost';

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function ok(cond, name) { eq(!!cond, true, name); }
function has(text, needle, name) { eq(String(text).indexOf(needle) !== -1, true, name); }

let chain = Promise.resolve();
function group(title, fn) {
  chain = chain.then(() => {
    console.log(`\n【${title}】`);
    return Promise.resolve().then(fn).catch(err => {
      fail++; failures.push(title + ' — ' + err.message);
      console.log(`  ✗ ${title}\n      抛出: ${err.message}`);
    });
  });
  return chain;
}
const flush = () => new Promise(r => setTimeout(r, 0));

/* ========== 假浏览器环境 ========== */

function makeRes(body, opts) {
  opts = opts || {};
  const r = { ok: opts.ok !== false, type: opts.type || 'basic', body: body };
  r.clone = () => makeRes(body, opts);
  return r;
}

/** 把 Request / 字符串统一成缓存键；绝对同源 URL 折成 './x' 形式 */
function keyOf(req) {
  if (typeof req === 'string') return req;
  const u = (req && req.url) || String(req);
  if (u.indexOf(ORIGIN) === 0) return '.' + u.slice(ORIGIN.length);
  return u;
}

/**
 * 假 Cache 对象。
 *
 * 重要：这里暴露的方法必须与浏览器真实 Cache 接口【完全一致】——
 *   add, addAll, delete, keys, match, matchAll, put
 * 曾经因为图省事给它加了一个不存在的 fetch()，导致 sw.js 里
 * `c.fetch(...)` 这种真机会抛 TypeError 的写法在测试里一路绿灯。
 * 现在第 5 组有一条元测试专门盯着这个「mock 不能比真机更宽容」。
 */
const REAL_CACHE_API = ['add', 'addAll', 'delete', 'keys', 'match', 'matchAll', 'put'];

function makeCaches(fetchImpl) {
  const stores = new Map();
  const bucket = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    _stores: stores,
    open(name) {
      const m = bucket(name);
      return Promise.resolve({
        put(req, res) { m.set(keyOf(req), res); return Promise.resolve(); },
        match(req) { return Promise.resolve(m.get(keyOf(req))); },
        matchAll() { return Promise.resolve(Array.from(m.values())); },
        keys() { return Promise.resolve(Array.from(m.keys()).map(k => ({ url: ORIGIN + k.replace(/^\./, '') }))); },
        delete(req) { return Promise.resolve(m.delete(keyOf(req))); },
        add(req) { return fetchImpl(keyOf(req)).then(r => { if (!r.ok) throw new Error('add 失败'); m.set(keyOf(req), r); return undefined; }); },
        // 保留原子的 addAll，用来证明 sw.js 已经不再依赖它
        addAll(urls) {
          return Promise.all(urls.map(u => fetchImpl(keyOf(u)).then(r => {
            if (!r.ok) throw new Error('addAll 原子失败: ' + keyOf(u));
            m.set(keyOf(u), r);
            return r;
          })));
        }
      });
    },
    keys() { return Promise.resolve(Array.from(stores.keys())); },
    delete(name) { stores.delete(name); return Promise.resolve(true); },
    match(req) {
      for (const m of stores.values()) if (m.has(keyOf(req))) return Promise.resolve(m.get(keyOf(req)));
      return Promise.resolve(undefined);
    }
  };
}

/** 加载一份 sw.js 并返回操作句柄 */
function load(fetchImpl) {
  const listeners = {};
  const caches = makeCaches(fetchImpl);
  const calls = { skipWaiting: 0, claim: 0 };
  const warnings = [];

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting() { calls.skipWaiting++; return Promise.resolve(); },
    clients: { claim() { calls.claim++; return Promise.resolve(); } }
  };

  const sandbox = {
    self, caches, fetch: fetchImpl, URL, Promise, console,
    Response: { error: () => makeRes('', { ok: false, type: 'error' }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sw.js' });

  return { listeners, caches, calls, warnings, sandbox };
}

function installEvent() {
  let p;
  const e = { waitUntil(x) { p = x; } };
  return { e, done: () => (p || Promise.resolve()) };
}
function activateEvent() {
  let p;
  const e = { waitUntil(x) { p = x; } };
  return { e, done: () => (p || Promise.resolve()) };
}
function fetchEvent(request) {
  let handled = false, promise;
  const e = { request, respondWith(x) { handled = true; promise = x; } };
  return { e, handled: () => handled, response: () => promise };
}
function fire(sw, type, event) {
  (sw.listeners[type] || []).forEach(fn => fn(event));
}

/* ========== 测试 ========== */

async function main() {
  console.log('sw.js 测试（node:vm 模拟 Service Worker 环境）');

  /* ---------- 1. ASSETS 清单健全性 ---------- */
  await group('1. 缓存清单健全性', () => {
    const sw = load(() => Promise.resolve(makeRes('ok')));
    const ASSETS = vm.runInContext('ASSETS', sw.sandbox);
    const CACHE = vm.runInContext('CACHE', sw.sandbox);

    ok(Array.isArray(ASSETS), 'ASSETS 是数组');
    ok(ASSETS.length > 0, `ASSETS 非空（${ASSETS.length} 项）`);

    // 回归点 1：'./'（目录根）会让不支持目录索引的服务器返回 404
    eq(ASSETS.indexOf('./'), -1, "ASSETS 不含 './'（目录根会 404，曾导致 install 失败）");

    // 所有条目都应是显式文件，而不是目录
    const dirLike = ASSETS.filter(u => u !== './' && !/\.[a-z0-9]+$/i.test(u));
    eq(dirLike, [], 'ASSETS 每一项都是具体文件（不是目录）');

    ok(/^mediontime-v\d+$/.test(CACHE), `缓存版本形如 mediontime-vN（当前 ${CACHE}）`);

    // 回归点 2：不得再使用原子的 addAll
    const usesAddAll = /\.addAll\s*\(/.test(SRC_CODE);
    eq(usesAddAll, false, 'sw.js 不再使用原子的 cache.addAll()');
    has(SRC, 'Promise.all', '改用 Promise.all + 逐项容错');

    // 回归点 3：Cache 接口没有 fetch()。误写成 c.fetch() 会让 install 直接抛错
    eq(/\bc\.fetch\s*\(/.test(SRC_CODE), false, 'sw.js 不调用不存在的 Cache.fetch()');
    has(SRC_CODE, 'fetch(url', '改用全局 fetch() 取资源');
  });

  /* ---------- 2. install：单个资源缺失不能拖垮整体 ---------- */
  await group('2. install 容错（回归核心）', async () => {
    // 2.1 全部可用
    {
      const sw = load(() => Promise.resolve(makeRes('ok')));
      const ev = installEvent();
      fire(sw, 'install', ev.e);
      await ev.done();
      const ASSETS = vm.runInContext('ASSETS', sw.sandbox);
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      const stored = sw.caches._stores.get(CACHE);
      eq(stored.size, ASSETS.length, `资源全可用时全部入缓存（${stored.size} 项）`);
      eq(sw.calls.skipWaiting, 1, 'install 完成后调用 skipWaiting');
    }

    // 2.2 某个资源返回 404（历史上预览服务器上的 .webmanifest 就是这种情形，
    //      后来改名为 manifest.json 才彻底避开；这里仍要保证缺一个不拖垮整体）
    {
      const MISSING = './manifest.json';
      const sw = load((url) => {
        if (url.indexOf('manifest.json') !== -1) return Promise.resolve(makeRes('', { ok: false }));
        return Promise.resolve(makeRes('ok'));
      });
      const ev = installEvent();
      fire(sw, 'install', ev.e);
      let threw = null;
      try { await ev.done(); } catch (e) { threw = e; }
      eq(threw, null, '某个资源 404 时 install 依然完成（不再整段失败）');
      eq(sw.calls.skipWaiting, 1, 'install 仍然调用 skipWaiting（SW 能装上）');
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      const stored = sw.caches._stores.get(CACHE);
      ok(stored.size > 0, `其余资源照常入缓存（${stored.size} 项）`);
      eq(stored.has(MISSING), false, '404 的那一项被跳过，不写脏数据');
    }

    // 2.3 全部 404（极端：离线首次安装）
    {
      const sw = load(() => Promise.resolve(makeRes('', { ok: false })));
      const ev = installEvent();
      fire(sw, 'install', ev.e);
      let threw = null;
      try { await ev.done(); } catch (e) { threw = e; }
      eq(threw, null, '全部 404 时 install 仍不抛错');
      eq(sw.calls.skipWaiting, 1, '仍调用 skipWaiting');
    }

    // 2.4 fetch 直接 reject（网络层异常）
    {
      const sw = load(() => Promise.reject(new Error('offline')));
      const ev = installEvent();
      fire(sw, 'install', ev.e);
      let threw = null;
      try { await ev.done(); } catch (e) { threw = e; }
      eq(threw, null, '网络异常时 install 仍不抛错');
    }
  });

  /* ---------- 3. activate：清旧留新 ---------- */
  await group('3. activate 清理旧缓存', async () => {
    const sw = load(() => Promise.resolve(makeRes('ok')));
    const CACHE = vm.runInContext('CACHE', sw.sandbox);
    sw.caches._stores.set('mediontime-v1', new Map());
    sw.caches._stores.set('mediontime-v2', new Map());
    sw.caches._stores.set(CACHE, new Map());

    const ev = activateEvent();
    fire(sw, 'activate', ev.e);
    await ev.done();

    const left = Array.from(sw.caches._stores.keys());
    eq(left, [CACHE], `只保留当前版本缓存（剩 ${left.join(',')}）`);
    eq(sw.calls.claim, 1, 'activate 调用 clients.claim');
  });

  /* ---------- 4. fetch：缓存优先 + 兜底 ---------- */
  await group('4. fetch 策略', async () => {
    // 4.1 命中缓存，不触碰网络
    {
      let net = 0;
      const sw = load(() => { net++; return Promise.resolve(makeRes('net')); });
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      sw.caches._stores.set(CACHE, new Map([['./index.html', makeRes('cached')]]));
      const ev = fetchEvent({ method: 'GET', url: ORIGIN + '/index.html' });
      fire(sw, 'fetch', ev.e);
      ok(ev.handled(), 'GET 同源请求被接管');
      const res = await ev.response();
      eq(res.body, 'cached', '命中缓存时直接返回缓存内容');
      eq(net, 0, '命中缓存时未发起网络请求');
    }

    // 4.2 未命中 → 走网络并写入缓存
    {
      const sw = load(() => Promise.resolve(makeRes('net')));
      const ev = fetchEvent({ method: 'GET', url: ORIGIN + '/js/app.js' });
      fire(sw, 'fetch', ev.e);
      const res = await ev.response();
      eq(res.body, 'net', '未命中时返回网络响应');
      await flush();
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      eq(sw.caches._stores.get(CACHE).has('./js/app.js'), true, '成功的响应被写入缓存');
    }

    // 4.3 非 GET 不接管
    {
      const sw = load(() => Promise.resolve(makeRes('net')));
      const ev = fetchEvent({ method: 'POST', url: ORIGIN + '/api' });
      fire(sw, 'fetch', ev.e);
      eq(ev.handled(), false, 'POST 请求不被 SW 接管');
    }

    // 4.4 跨域不接管（避免误缓存第三方响应）
    {
      const sw = load(() => Promise.resolve(makeRes('net')));
      const ev = fetchEvent({ method: 'GET', url: 'https://example.com/x.js' });
      fire(sw, 'fetch', ev.e);
      eq(ev.handled(), false, '跨域请求不被 SW 接管');
    }

    // 4.5 网络失败 → 回退到缓存的 index.html
    {
      const sw = load(() => Promise.reject(new Error('offline')));
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      sw.caches._stores.set(CACHE, new Map([['./index.html', makeRes('shell')]]));
      const ev = fetchEvent({ method: 'GET', url: ORIGIN + '/js/whatever.js' });
      fire(sw, 'fetch', ev.e);
      const res = await ev.response();
      eq(res.body, 'shell', '离线且无缓存时回退到应用外壳 index.html');
    }

    // 4.6 网络失败且外壳也没缓存 → 返回错误响应而不是 undefined
    {
      const sw = load(() => Promise.reject(new Error('offline')));
      const ev = fetchEvent({ method: 'GET', url: ORIGIN + '/js/whatever.js' });
      fire(sw, 'fetch', ev.e);
      const res = await ev.response();
      ok(res && res.type === 'error', '连外壳都没有时返回 Response.error()（不能返回 undefined）');
    }

    // 4.7 非 2xx 响应不写缓存
    {
      const sw = load(() => Promise.resolve(makeRes('', { ok: false })));
      const ev = fetchEvent({ method: 'GET', url: ORIGIN + '/js/missing.js' });
      fire(sw, 'fetch', ev.e);
      await ev.response();
      await flush();
      const CACHE = vm.runInContext('CACHE', sw.sandbox);
      // 缓存桶可能压根没被创建（什么都没写），此时视为「未写入」
      const bucket = sw.caches._stores.get(CACHE) || new Map();
      eq(bucket.has('./js/missing.js'), false, '404 响应不会被写进缓存');
    }
  });

  /* ---------- 5. mock 保真度 ---------- */
  await group('5. mock 保真度（mock 不得比真机更宽容）', async () => {
    const sw = load(() => Promise.resolve(makeRes('ok')));
    const c = await sw.caches.open('probe');

    const extra = Object.keys(c).filter(k => REAL_CACHE_API.indexOf(k) === -1);
    eq(extra, [], '假 Cache 不提供真实接口之外的方法（否则会放过不存在的 API）');
    eq(Object.keys(c).sort().join(','), REAL_CACHE_API.slice().sort().join(','),
      '假 Cache 的方法集合与真机完全一致');
    eq(typeof c.fetch, 'undefined', '假 Cache 明确没有 fetch()（与真机一致）');
  });

  /* ---------- 6. index.html 的注册守卫 ---------- */
  await group('6. 注册守卫（嵌入式预览不得注册 SW）', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    has(html, 'window.self !== window.top', 'index.html 检测是否处于 iframe 中');
    has(html, '!embedded', '嵌入式环境下跳过 SW 注册');
    has(html, "location.protocol.indexOf('http') === 0", '仍只在 http(s) 下注册');
    has(html, 'try { embedded =', '跨域父窗口取值做了 try/catch 兜底');
  });

  await chain;
  console.log('\n' + '─'.repeat(52));
  console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  console.log('─'.repeat(52));
  if (fail) {
    console.log('失败用例：');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
}

main().catch(err => { console.error('测试运行异常：', err); process.exit(2); });
