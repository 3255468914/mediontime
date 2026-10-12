/*!
 * relay.mjs — 家属协同中继服务（零依赖）
 *
 * 为什么需要它：
 *   服药提醒是**本机**能做的事，但"家属收到漏服通知"在物理上做不到——
 *   家属在另一台设备上，本地通知走不出这台机器。
 *   所以"家属协同"必须有一个中转点。本项目把这个中转点做成**你可以自己部署**的
 *   一个小服务，而不是绑定到某个云服务：默认不配置 = 完全不联网。
 *
 * 职责只有一个：把"某位患者的某条提醒到达了 L4（该通知家属）"这个**事实**
 *   转交给已经用邀请码绑定过的家属设备。
 *   不存药品明细、不做统计、不参与任何业务判断。
 *
 * 接口：
 *   POST /api/pair     { code, patientToken, patientLabel }
 *        患者登记一个邀请码（码由患者端本地生成）
 *   POST /api/claim    { code, caregiverLabel }            -> { caregiverToken }
 *        家属凭邀请码绑定，拿到长期令牌
 *   GET  /api/events?token=<caregiverToken>                 -> text/event-stream
 *        家属建立长连接，实时接收事件
 *   POST /api/report   { patientToken, event }              -> { delivered, caregivers }
 *        患者上报事件，服务扇出给该码下所有家属
 *   POST /api/notify-schedule { patientToken, items:[{reminderId, scheduledAt, notifyAt}] }
 *        患者端把「每剂该通知家属的时刻」全量上报给中继，由中继计时。
 *        这是 L4 可靠性的关键：患者手机熄屏/被冻结后页面内的 JS 定时器不再运行，
 *        「该通知家属」只能靠一个一直活着的进程来计时——那就是中继。
 *        全量对账语义：以本次上报为准，没有出现的旧条目自动清除（幂等）。
 *        隐私：条目只有提醒的**内部随机 id** 与时刻，没有药名与剂量。
 *   POST /api/notify-cancel { patientToken, reminderIds:[...] }
 *        患者确认/跳过某剂后撤销对应待办，家属不会再被打扰。
 *   POST /api/push-subscribe { caregiverToken, subscription }
 *        家属登记 Web Push 订阅（用于页面关闭时也能收到）
 *   GET  /api/health
 *
 * 零依赖：只用 node:http / node:fs / node:crypto。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* ---------- 工具 ---------- */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...cors()
  });
  res.end(body);
};

/** 开发/自建场景放开跨域；生产建议在反向代理层收紧到自己的域名。 */
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** 邀请码规范化：大小写不敏感、去掉空格与连字符之外的分隔噪音 */
export function normalizeCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase().replace(/\s+/g, '');
}

export function newToken(prefix) {
  return (prefix || 'tk') + '_' + crypto.randomBytes(16).toString('hex');
}

/* ---------- 状态持久化 ---------- */

function blankState() {
  return {
    version: 1,
    invites: {},      // CODE -> { code, patientToken, patientLabel, createdAt }
    patients: {},     // patientToken -> CODE
    caregivers: {},   // caregiverToken -> { token, code, label, createdAt, subscriptions: [] }
    watches: {},      // patientToken|reminderId -> { reminderId, code, scheduledAt, notifyAt, createdAt }
    events: []        // 最近上报（仅用于观测，不参与投递）
  };
}

function loadState(dataFile) {
  if (!dataFile) return blankState();
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) {
      // 旧版本状态文件没有 watches 字段：补齐而不是整体作废——
      // 邀请码与家属绑定关系是用户真实配置，不能因为升级就把人踢下线
      if (!parsed.watches) parsed.watches = {};
      return parsed;
    }
  } catch (e) { /* 首次运行或文件损坏：重建 */ }
  return blankState();
}

function saveState(dataFile, state) {
  if (!dataFile) return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    // 先写临时文件再改名，避免进程中途挂掉留下半截 JSON
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, dataFile);
  } catch (e) {
    console.warn('[relay] 状态持久化失败：', e.message);
  }
}

/* ---------- SSE ---------- */

function sseWrite(res, eventName, dataObj) {
  // 单条事件可能含换行，必须按 SSE 规范拆成多个 data: 行，否则会被截断成非法帧
  const payload = JSON.stringify(dataObj).split('\n').map((l) => 'data: ' + l).join('\n');
  res.write('event: ' + eventName + '\n' + payload + '\n\n');
}

/* ---------- 服务 ---------- */

/**
 * @param {Object} opts
 * @param {String} opts.dataFile  状态文件路径（不传 = 纯内存，适合测试）
 * @param {Object} opts.push      推送通道（见 push.mjs），不传 = 只用 SSE
 * @param {Number} opts.maxEvents 内存里保留的最近事件条数
 * @param {Number} opts.watchIntervalMs 「通知家属」待办的扫描间隔（默认 15 秒；测试可调小，传 0 关闭）
 */
export function createRelay(opts = {}) {
  const dataFile = opts.dataFile || null;
  const state = loadState(dataFile);
  const push = opts.push || null;
  const maxEvents = opts.maxEvents || 200;
  const maxWatchesPerPatient = 300;   // 托管上限同源：防止异常客户端把内存撑爆

  /** caregiverToken -> Set<ServerResponse> 仍在线的 SSE 连接 */
  const streams = new Map();

  function persist() { saveState(dataFile, state); }

  function onlineCaregivers(code) {
    return Object.values(state.caregivers).filter((c) => c.code === code);
  }

  /**
   * 把事件投递给某邀请码下的所有家属。
   * 返回**真实**送达数：SSE 在线算送达；登记了 Web Push 的另算一次投递尝试，
   * 结果如实记在 push 计数里。绝不为了好看而凑数。
   */
  async function deliver(code, event) {
    const list = onlineCaregivers(code);
    let sseDelivered = 0;
    let pushAttempted = 0;
    let pushDelivered = 0;
    const pushErrors = [];

    for (const c of list) {
      const set = streams.get(c.token);
      if (set && set.size) {
        for (const res of set) {
          try { sseWrite(res, 'alert', event); sseDelivered++; }
          catch (e) { /* 连接已断，交给 close 事件清理 */ }
        }
      }
      if (push && c.subscriptions && c.subscriptions.length) {
        for (const sub of c.subscriptions) {
          pushAttempted++;
          try {
            await push.send(sub, event);
            pushDelivered++;
          } catch (e) {
            // 订阅过期（404/410）时移除，避免每次都白试
            if (e && (e.statusCode === 404 || e.statusCode === 410)) {
              c.subscriptions = c.subscriptions.filter((s) => s !== sub);
              persist();
            }
            pushErrors.push(e && e.message ? e.message : String(e));
          }
        }
      }
    }

    return { caregivers: list.length, sseDelivered, pushAttempted, pushDelivered, pushErrors };
  }

  /* ---------- L4「通知家属」中继计时 ----------
   *
   * 为什么这件事必须在中继做：升级链的 L1~L3 由患者手机的系统闹钟托管，
   * 但 L4 原先靠患者手机**页面里的 JS 定时器**驱动——手机熄屏/进程被冻结后
   * 定时器不再运行，而「患者已经没反应了」恰恰是最可能熄屏的时刻。
   * 患者端在排程变化时把每剂的 L4 时刻上报上来，由这个**一直活着的进程**计时；
   * 到点仍未收到撤销 → 推送给家属。失败方向是安全的：
   * 患者手机死机/关机/被冻结时家属照样收到，这正是期望行为。
   */

  const WATCH_EVENT_TEXT = '有一条用药提醒已到「通知家属」时刻，且未收到患者确认';

  /** 某患者令牌下的全部待办（按创建时间序） */
  function watchesOf(patientToken) {
    return Object.keys(state.watches)
      .filter((k) => state.watches[k].patientToken === patientToken)
      .map((k) => state.watches[k]);
  }

  /**
   * 扫描到点的待办并推送。now 缺省取当前时间。
   * 返回 { due, sent } —— due 是本轮扫描发现的到点条数，sent 是实际推送的条数。
   * 每条到点待办**只推一次**（推完即删，事件副本留在 events 观测列表里）；
   * 家属当时不在线且未启用 Web Push 导致的漏收，与现有 /api/report 的边界一致。
   */
  async function checkWatches(now) {
    const t = (now == null) ? Date.now() : new Date(now).getTime();
    let due = 0;
    let sent = 0;

    for (const key of Object.keys(state.watches)) {
      const w = state.watches[key];
      const at = new Date(w.notifyAt).getTime();
      if (!Number.isFinite(at) || at > t) continue;
      due++;
      delete state.watches[key];

      const record = {
        id: crypto.randomUUID(),
        code: w.code,
        type: 'missed',
        level: 4,
        reminderId: w.reminderId,
        scheduledAt: w.scheduledAt || null,
        text: WATCH_EVENT_TEXT,
        via: 'relay-watch',   // 让家属端/排查时能区分「中继计时推送」与「患者端实时上报」
        receivedAt: new Date().toISOString()
      };
      state.events.push(record);
      if (state.events.length > maxEvents) state.events.splice(0, state.events.length - maxEvents);

      const r = await deliver(w.code, record);
      if (r.sseDelivered + r.pushDelivered > 0) sent++;
    }
    if (due) persist();
    return { due, sent };
  }

  let watchTimer = null;
  const watchIntervalMs = (opts.watchIntervalMs === undefined) ? 15000 : opts.watchIntervalMs;
  if (watchIntervalMs > 0) {
    watchTimer = setInterval(() => { checkWatches().catch(() => { }); }, watchIntervalMs);
    if (watchTimer.unref) watchTimer.unref();   // 不阻止进程退出
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      return res.end();
    }

    try {
      /* ----- 健康检查 ----- */
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true, service: 'mediontime-relay',
          invites: Object.keys(state.invites).length,
          caregivers: Object.keys(state.caregivers).length,
          watches: Object.keys(state.watches).length,
          sseClients: Array.from(streams.values()).reduce((n, s) => n + s.size, 0),
          push: !!push
        });
      }

      /* ----- 家属端取 VAPID 公钥（用于注册 Web Push 订阅） ----- */
      if (req.method === 'GET' && url.pathname === '/api/vapid') {
        return json(res, 200, {
          ok: true,
          // 没有启用 Web Push 时如实返回 null，家属端据此说明"仅页面打开时能收到"
          publicKey: push ? push.vapidPublicKey : null
        });
      }

      /* ----- 患者登记邀请码 ----- */
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const b = await readBody(req);
        const code = normalizeCode(b.code);
        const patientToken = String(b.patientToken || '');
        if (!code || code.length < 4) return json(res, 400, { ok: false, error: '邀请码格式不正确' });
        if (!patientToken) return json(res, 400, { ok: false, error: '缺少患者令牌' });

        // 一个患者令牌只能绑一个码；重复登记同一码是幂等的（刷新页面会重复调用）
        const prev = state.patients[patientToken];
        if (prev && prev !== code) {
          // 轮换邀请码（例如码被泄露了）。这里**必须把已绑定的家属迁到新码上**：
          // 若只删旧码，家属记录里的 code 就指向一个已不存在的码，
          // 患者从此上报到新码，而家属那边永远收不到——**静默失联**，没有任何报错。
          // 这正是本项目一直在打的那类"看起来正常、实际不工作"。
          let migrated = 0;
          Object.values(state.caregivers).forEach((c) => {
            if (c.code === prev) { c.code = code; migrated++; }
          });
          // 计时待办同样挂在中继的码上：不迁移的话，轮换邀请码后
          // 待办还在给旧码推送，家属一个也收不到——又一类静默失联
          Object.values(state.watches).forEach((w) => {
            if (w.code === prev) w.code = code;
          });
          if (migrated) console.log('[relay] 邀请码轮换：' + migrated + ' 位家属已迁移到新码');
          delete state.invites[prev];
        }
        // 该码若被其它令牌占用，拒绝——否则会出现两台设备抢同一个码
        const holder = state.invites[code];
        if (holder && holder.patientToken !== patientToken) {
          return json(res, 409, { ok: false, error: '该邀请码已被占用，请重新生成' });
        }

        state.invites[code] = {
          code, patientToken,
          patientLabel: String(b.patientLabel || '家人'),
          createdAt: (holder && holder.createdAt) || new Date().toISOString()
        };
        state.patients[patientToken] = code;
        persist();
        return json(res, 200, { ok: true, code, caregiversBound: onlineCaregivers(code).length });
      }

      /* ----- 家属绑定 ----- */
      if (req.method === 'POST' && url.pathname === '/api/claim') {
        const b = await readBody(req);
        const code = normalizeCode(b.code);
        const inv = state.invites[code];
        if (!inv) return json(res, 404, { ok: false, error: '邀请码无效或已失效' });

        const token = newToken('cg');
        state.caregivers[token] = {
          token, code,
          label: String(b.caregiverLabel || '家属'),
          createdAt: new Date().toISOString(),
          subscriptions: []
        };
        persist();
        return json(res, 200, {
          ok: true, caregiverToken: token, code,
          patientLabel: inv.patientLabel
        });
      }

      /* ----- 家属 SSE 长连接 ----- */
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const token = url.searchParams.get('token') || '';
        const cg = state.caregivers[token];
        if (!cg) return json(res, 401, { ok: false, error: '令牌无效' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',   // 让 nginx 之类不要缓冲，否则事件会被攒着
          ...cors()
        });
        res.write('retry: 3000\n\n');   // 断线后 3 秒重连
        sseWrite(res, 'ready', { ok: true, patientLabel: (state.invites[cg.code] || {}).patientLabel || '家人' });

        if (!streams.has(token)) streams.set(token, new Set());
        streams.get(token).add(res);

        // 心跳：既保活，也让 nginx/运营商别把空闲连接掐了
        const hb = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (e) { /* 已断开 */ }
        }, 25000);

        const cleanup = () => {
          clearInterval(hb);
          const s = streams.get(token);
          if (s) { s.delete(res); if (!s.size) streams.delete(token); }
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
      }

      /* ----- 患者上报事件 ----- */
      if (req.method === 'POST' && url.pathname === '/api/report') {
        const b = await readBody(req);
        const patientToken = String(b.patientToken || '');
        const code = state.patients[patientToken];
        if (!code) return json(res, 401, { ok: false, error: '未登记的设备令牌，请先在家属协同里创建邀请码' });

        const ev = b.event || {};
        // 防重复推送：页面内引擎真的触发了 L4（说明患者手机此刻活着），
        // 对应的中继计时待办就该撤销——否则家属会收到两条同样的通知。
        // reminderId 是内部随机 id，不含药名，放进白名单事件没有隐私问题。
        if (ev.reminderId) {
          const wk = patientToken + '|' + String(ev.reminderId);
          if (state.watches[wk]) { delete state.watches[wk]; persist(); }
        }

        const record = {
          id: crypto.randomUUID(),
          code,
          type: String(ev.type || 'alert'),
          level: Number(ev.level) || 0,
          scheduledAt: ev.scheduledAt || null,
          text: String(ev.text || '').slice(0, 500),
          receivedAt: new Date().toISOString()
        };
        state.events.push(record);
        if (state.events.length > maxEvents) state.events.splice(0, state.events.length - maxEvents);
        persist();

        const r = await deliver(code, record);
        return json(res, 200, {
          ok: true,
          delivered: r.sseDelivered + r.pushDelivered,
          caregivers: r.caregivers,
          detail: r
        });
      }

      /* ----- 患者上报「通知家属」计时待办（全量对账） ----- */
      if (req.method === 'POST' && url.pathname === '/api/notify-schedule') {
        const b = await readBody(req);
        const patientToken = String(b.patientToken || '');
        const code = state.patients[patientToken];
        if (!code) return json(res, 401, { ok: false, error: '未登记的设备令牌，请先在家属协同里创建邀请码' });

        // 全量对账：先清掉这个患者的全部旧待办，再登记本次上报的。
        // 这样患者端删药、改时间、关掉家属通道，中继都自动跟上，
        // 不需要再设计一套增量 diff 协议——幂等且实现只有一步。
        for (const k of Object.keys(state.watches)) {
          if (state.watches[k].patientToken === patientToken) delete state.watches[k];
        }

        const items = Array.isArray(b.items) ? b.items : [];
        let watched = 0;
        for (const it of items.slice(0, maxWatchesPerPatient)) {
          const reminderId = String(it && it.reminderId || '');
          const notifyAt = new Date(it && it.notifyAt).toISOString();
          if (!reminderId || !Number.isFinite(new Date(notifyAt).getTime())) continue;
          state.watches[patientToken + '|' + reminderId] = {
            patientToken,
            code,
            reminderId,
            scheduledAt: it.scheduledAt ? new Date(it.scheduledAt).toISOString() : null,
            notifyAt,
            createdAt: new Date().toISOString()
          };
          watched++;
        }
        persist();
        return json(res, 200, { ok: true, watched });
      }

      /* ----- 患者撤销「通知家属」待办（确认/跳过/补录后调用） ----- */
      if (req.method === 'POST' && url.pathname === '/api/notify-cancel') {
        const b = await readBody(req);
        const patientToken = String(b.patientToken || '');
        if (!state.patients[patientToken]) {
          return json(res, 401, { ok: false, error: '未登记的设备令牌，请先在家属协同里创建邀请码' });
        }
        const ids = Array.isArray(b.reminderIds) ? b.reminderIds.map(String) : [];
        let cancelled = 0;
        for (const id of ids) {
          const wk = patientToken + '|' + id;
          if (state.watches[wk]) { delete state.watches[wk]; cancelled++; }
        }
        if (cancelled) persist();
        return json(res, 200, { ok: true, cancelled });
      }

      /* ----- 家属登记 Web Push 订阅 ----- */
      if (req.method === 'POST' && url.pathname === '/api/push-subscribe') {
        const b = await readBody(req);
        const cg = state.caregivers[String(b.caregiverToken || '')];
        if (!cg) return json(res, 401, { ok: false, error: '令牌无效' });

        const sub = b.subscription;
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json(res, 400, { ok: false, error: '订阅对象不完整（需要 endpoint/p256dh/auth）' });
        }
        // 同一 endpoint 只留一条，重复登记（如重装 PWA）不应该无限增长
        cg.subscriptions = cg.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
        cg.subscriptions.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        persist();
        return json(res, 200, { ok: true, subscriptions: cg.subscriptions.length });
      }

      /* ----- 家属解绑 ----- */
      if (req.method === 'POST' && url.pathname === '/api/unclaim') {
        const b = await readBody(req);
        const token = String(b.caregiverToken || '');
        if (state.caregivers[token]) {
          delete state.caregivers[token];
          const s = streams.get(token);
          if (s) { for (const r of s) { try { r.end(); } catch (e) { } } streams.delete(token); }
          persist();
        }
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message || 'bad request' });
    }
  });

  return {
    server,
    state,
    streams,
    deliver,
    checkWatches,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      for (const set of streams.values()) {
        for (const res of set) { try { res.end(); } catch (e) { } }
      }
      streams.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

/* ---------- 直接运行：node server/relay.mjs [--port 8789] [--data <file>] ----------
 *
 * 这里踩过一个坑，值得留一行说明：
 * 原先用 `new URL(import.meta.url).pathname` 取路径，在 Windows 上会得到
 * `/D:/workbuddy%20file/...` —— 百分号编码没有被解码，于是状态文件被写到一个
 * 名字里真的带 `%20` 的目录下。更糟的是 saveState 会吞掉异常，
 * 所以服务"启动成功、日志正常"，而**数据一个字都没存下来**。
 * 换成 fileURLToPath 后才是真正的文件路径。
 */
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const port = Number(getArg('port', 8789));
  // 默认只监听 127.0.0.1（本机自测）。手机/家属端要访问必须显式 --host 0.0.0.0——
  // 这里曾与 docs/08 §五 矛盾：文档写"局域网内填 192.168.x.x 即可"，
  // 实现却只听回环，手机怎么都连不上。2026-10-11 首轮真机联调时发现，补上 --host。
  const host = getArg('host', '127.0.0.1');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataFile = getArg('data', path.join(here, 'data', 'relay.json'));

  let push = null;
  try {
    const mod = await import('./push.mjs');
    const keys = mod.loadOrCreateVapidKeys(path.join(path.dirname(dataFile), 'vapid.json'));
    push = mod.createPushSender({ vapidKeys: keys, subject: getArg('subject', 'mailto:caregiver@example.com') });
    console.log('[relay] Web Push 已启用，VAPID 公钥：', keys.publicKey);
  } catch (e) {
    // 推送不可用时降级为"只用 SSE"，并明确说出来——
    // 家属端会据此显示"后台推送：服务器未启用"，而不是以为自己开着推送却收不到。
    console.warn('[relay] Web Push 不可用（仅 SSE，页面关闭时收不到）：', e.message);
  }

  const relay = createRelay({ dataFile, push });
  const actual = await relay.listen(port, host);
  console.log(`[relay] 家属协同中继已启动： http://127.0.0.1:${actual}（监听 ${host}:${actual}）`);
  if (host === '0.0.0.0') {
    console.warn('[relay] 已监听所有网卡（0.0.0.0）：局域网内任何设备都能以明文 HTTP 访问本中继，'
      + '仅建议在可信网络使用；公网部署必须加 HTTPS 反代（见 docs/08 §五/§六）。');
  }
  console.log(`[relay] 状态文件： ${dataFile}`);
  console.log('[relay] 患者端在「我的 → 家属协同」填入上面这个地址即可。');
}
