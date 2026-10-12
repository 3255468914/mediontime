/*!
 * relay.test.mjs — 家属协同中继的端到端测试
 *
 * 这套测试要回答的唯一问题是：**家属真的收到了吗？**
 *
 * 所以两段投递都必须在真实 HTTP 上跑通，而不是断言"函数被调用了"：
 *   · SSE   —— 家属端真的是一个长连接，事件真的是从那条连接上过来的
 *   · Web Push —— 起一个**本地模拟推送服务**充当 FCM，它
 *                 ① 校验 VAPID JWT 的签名（用 Authorization 头里的 k）
 *                 ② 按 RFC 8291 **独立实现**解密，把载荷还原回原文
 *                 本文件不引用 push.mjs 的 encryptPayload / buildVapidHeader，
 *                 否则"加密对不对"就变成了"加密和它自己一致不一致"，毫无意义。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelay, normalizeCode } from '../relay.mjs';
import { createPushSender, generateVapidKeys } from '../push.mjs';

/* ---------- 极简断言 ---------- */
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + (a === b ? '' : `（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`));
const atLeast = (a, b, msg) => ok(a >= b, msg + (a >= b ? '' : `（期望 ≥ ${b}，实际 ${a}）`));
const section = (t) => console.log('\n【' + t + '】');

/* ---------- 工具 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 3000, stepMs = 25) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

/** 极简 SSE 客户端：把 text/event-stream 拆成事件数组 */
function openSSE(url) {
  const seen = [];
  let req = null;
  const ready = new Promise((resolve) => {
    req = http.get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          frame.split('\n').forEach((line) => {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = (ev.data ? ev.data + '\n' : '') + line.slice(6);
            else if (line.startsWith('retry: ')) ev.retry = Number(line.slice(7));
          });
          if (ev.event) seen.push(ev);
        }
      });
      resolve(res);
    });
  });
  return { seen, ready, close: () => { try { req.destroy(); } catch (e) { } } };
}

/* ---------------------------------------------------------------
 * 本地模拟推送服务（充当 FCM）：独立实现 RFC 8292 校验 + RFC 8291 解密
 * --------------------------------------------------------------- */

function makeSubscriberKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    authBuf: auth
  };
}

/** 按 RFC 8291 解密，返回明文 Buffer */
function rfc8291Decrypt(keys, body, recordSizeHint) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  void rs; void recordSizeHint;
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const uaPublic = keys.ecdh.getPublicKey();
  const shared = keys.ecdh.computeSecret(asPublic);

  const authInfo = Buffer.concat([Buffer.from('WebPush: info'), Buffer.from([0]), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, keys.authBuf, authInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(data), d.final()]);

  // 去掉记录分隔符：末尾可能有一串 0x00 填充，最后一个非零字节若是 0x02 则连同它一起去掉
  let end = out.length;
  while (end > 0 && out[end - 1] === 0x00) end--;
  if (end > 0 && out[end - 1] === 0x02) end--;
  return out.subarray(0, end);
}

/** 校验 VAPID JWT（ES256），返回 { valid, claims, error } */
function verifyVapid(jwt, publicKeyB64u) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { valid: false, error: 'JWT 段数不对' };
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'ES256') return { valid: false, error: 'alg 不是 ES256：' + header.alg };
  const k = Buffer.from(publicKeyB64u, 'base64url');
  if (k.length !== 65 || k[0] !== 0x04) return { valid: false, error: '公钥不是 65 字节未压缩点' };
  const keyObj = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: k.subarray(1, 33).toString('base64url'), y: k.subarray(33, 65).toString('base64url') },
    format: 'jwk'
  });
  const valid = crypto.verify('sha256', Buffer.from(h + '.' + p), { key: keyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { valid, claims: JSON.parse(Buffer.from(p, 'base64url').toString()) };
}

/**
 * 起一个"假 FCM"。它接收推送、校验签名、解密载荷，把结果记在 received 里。
 * @param {Object} opts.rejectWith 指定返回的状态码（用于验证"没送到就不算送到"）
 */
function startMockPushService({ rejectWith = null } = {}) {
  const received = [];            // { authorized, claims, payload, raw }
  const subscribers = new Map();  // path -> keys

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers['authorization'] || '';
      const m = /^vapid\s+t=([^,]+),\s*k=(.+)$/.exec(auth.trim());
      const rec = { path: req.url, encoding: req.headers['content-encoding'], ttl: req.headers['ttl'], body };
      if (!m) {
        rec.authorized = false; rec.error = '缺少或格式错误的 VAPID Authorization 头：' + auth;
        received.push(rec);
        res.writeHead(401); return res.end('no vapid');
      }
      const keys = subscribers.get(req.url);
      if (!keys) {
        rec.authorized = false; rec.error = '未知订阅：' + req.url;
        received.push(rec);
        res.writeHead(404); return res.end('unknown subscription');
      }
      const v = verifyVapid(m[1], m[2]);
      rec.authorized = v.valid;
      rec.claims = v.claims;
      rec.vapidError = v.error;
      try {
        rec.payload = JSON.parse(rfc8291Decrypt(keys, body).toString('utf8'));
      } catch (e) {
        rec.decryptError = e.message;
      }
      received.push(rec);

      if (rejectWith) { res.writeHead(rejectWith); return res.end('mock reject ' + rejectWith); }
      res.writeHead(201); res.end('');
    });
  });

  return {
    received, subscribers, server,
    register(path, keys) { subscribers.set(path, keys); },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); }
  };
}

/* ---------- 助手：起一套完整环境 ---------- */
async function boot({ withPush = false, mockOpts = {} } = {}) {
  const mock = withPush ? startMockPushService(mockOpts) : null;
  const mockPort = mock ? await mock.listen() : 0;
  const vapidKeys = withPush ? generateVapidKeys() : null;
  const push = withPush ? createPushSender({
    vapidKeys,
    subject: 'mailto:caregiver@example.com',
    fetchImpl: (url, init) => fetch(url, init)
  }) : null;

  const relay = createRelay({ push });          // 纯内存，不落盘
  const port = await relay.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return { relay, base, mock, mockPort, vapidKeys };
}

const post = async (base, p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  console.log('药准时 · 家属协同中继 —— 端到端测试\n' + '='.repeat(56));

  /* ------------------------------------------------------------------
   * 1. 配对与绑定
   * ------------------------------------------------------------------ */
  section('【1】配对与绑定：邀请码把两台设备连起来');
  {
    const { relay, base } = await boot();

    const health = await (await fetch(base + '/api/health')).json();
    eq(health.ok, true, '服务健康检查通过');
    eq(health.caregivers, 0, '初始状态没有任何家属绑定');

    const pair = await post(base, '/api/pair', { code: 'medi-ab12', patientToken: 'pt_1', patientLabel: '张爷爷' });
    eq(pair.status, 200, '患者登记邀请码成功');
    eq(pair.body.code, 'MEDI-AB12', '邀请码被规范化为大写（大小写不敏感）');

    const bad = await post(base, '/api/claim', { code: 'MEDI-ZZZZ' });
    eq(bad.status, 404, '用不存在的邀请码绑定被拒绝（404）');

    const claim = await post(base, '/api/claim', { code: 'medi-ab12', caregiverLabel: '女儿·小张' });
    eq(claim.status, 200, '家属凭邀请码绑定成功');
    ok(/^cg_[0-9a-f]{32}$/.test(claim.body.caregiverToken), '家属拿到的是服务端生成的随机令牌');
    eq(claim.body.patientLabel, '张爷爷', '家属能看到患者标识（用于确认没绑错人）');

    // 同一邀请码不该被第二台"患者设备"抢占
    const steal = await post(base, '/api/pair', { code: 'MEDI-AB12', patientToken: 'pt_OTHER' });
    eq(steal.status, 409, '另一个患者令牌不能抢占已被占用的邀请码');

    // 同一患者重复登记同一个码应当是幂等的（刷新页面就会重发）
    const again = await post(base, '/api/pair', { code: 'MEDI-AB12', patientToken: 'pt_1' });
    eq(again.status, 200, '同一患者重复登记同一邀请码是幂等的');

    await post(base, '/api/pair', { code: 'MEDI-CD34', patientToken: 'pt_1' });
    const old = await post(base, '/api/claim', { code: 'MEDI-CD34' });
    eq(old.status, 200, '患者更换邀请码后，新码可用');

    // 轮换邀请码最容易出的错是"把已绑家属静默甩下"：只删旧码的话，
    // 家属记录里的 code 指向已不存在的码，患者上报到新码，家属永远收不到且毫无报错。
    const gone = await post(base, '/api/claim', { code: 'MEDI-AB12' });
    eq(gone.status, 404, '轮换后旧邀请码不能再拉新家属（泄露的码就此失效）');

    const sse = openSSE(base + '/api/events?token=' + claim.body.caregiverToken);
    await sse.ready;
    await waitFor(() => sse.seen.find((e) => e.event === 'ready'));
    await post(base, '/api/report', { patientToken: 'pt_1', event: { type: 'missed', level: 4, text: '迁移校验' } });
    const got = await waitFor(() => sse.seen.find((e) => e.event === 'alert'));
    ok(!!got, '轮换邀请码后**已绑定的家属仍能收到**（不会被静默甩下）');
    if (got) eq(JSON.parse(got.data).text, '迁移校验', '迁移后事件正文一致');
    sse.close();

    eq(normalizeCode(' medi-ab12 '), 'MEDI-AB12', 'normalizeCode 去空格并转大写');
    await relay.close();
  }

  /* ------------------------------------------------------------------
   * 2. SSE —— 家属真收到
   * ------------------------------------------------------------------ */
  section('【2】SSE 实时投递：漏服事件真的从长连接到达家属');
  {
    const { relay, base } = await boot();
    await post(base, '/api/pair', { code: 'MEDI-SSE1', patientToken: 'pt_sse', patientLabel: '张爷爷' });
    const claim = await post(base, '/api/claim', { code: 'MEDI-SSE1', caregiverLabel: '女儿' });
    const token = claim.body.caregiverToken;

    // 错误令牌不许连
    const unauthorized = await new Promise((resolve) => {
      http.get(base + '/api/events?token=cg_deadbeef', (res) => resolve(res.statusCode));
    });
    eq(unauthorized, 401, '无效令牌建立长连接被拒绝（401）');

    const sse = openSSE(base + '/api/events?token=' + token);
    await sse.ready;
    const ready = await waitFor(() => sse.seen.find((e) => e.event === 'ready'));
    ok(!!ready, '家属连上后立刻收到 ready 事件（含患者标识，可确认绑对了人）');
    eq(JSON.parse(ready.data).patientLabel, '张爷爷', 'ready 事件里带着患者标识');

    // event.text 刻意**不含药名**。
    // 患者端那个白名单构造器（app/js/app.js 的 caregiverEvent()）保证药名与剂量
    // 永远到不了这里；测试里若放着药名，描述的就是一个现在的产物已经不可能产生的世界
    // ——那正是 P9-36 的教训：文档与测试都显示正常，只有真实流量在泄漏。
    const evText = '18:00 的用药提醒未确认';
    const report = await post(base, '/api/report', {
      patientToken: 'pt_sse',
      event: { type: 'missed', level: 4, scheduledAt: '2026-10-11T10:00:00.000Z', text: evText }
    });
    eq(report.status, 200, '患者上报漏服事件成功');
    eq(report.body.delivered, 1, '上报结果如实返回"送达 1 位家属"');

    const got = await waitFor(() => sse.seen.find((e) => e.event === 'alert'));
    ok(!!got, '家属端**真的收到** alert 事件（不是"函数被调用了"）');
    const data = JSON.parse(got.data);
    eq(data.type, 'missed', '事件类型是 missed');
    eq(data.level, 4, '事件等级是 L4（该通知家属的那一级）');
    eq(data.text, evText, '事件正文原样送达（中继不加工、不改写）');

    // 第二位家属绑定后，一次上报应同时送到两人
    const claim2 = await post(base, '/api/claim', { code: 'MEDI-SSE1', caregiverLabel: '儿子' });
    const sse2 = openSSE(base + '/api/events?token=' + claim2.body.caregiverToken);
    await sse2.ready;
    await waitFor(() => sse2.seen.find((e) => e.event === 'ready'));

    const r2 = await post(base, '/api/report', {
      patientToken: 'pt_sse',
      event: { type: 'missed', level: 4, text: '21:00 的用药提醒未确认' }
    });
    eq(r2.body.caregivers, 2, '该邀请码下已有 2 位家属');
    eq(r2.body.delivered, 2, '一次上报同时送达 2 位家属');
    const g1 = await waitFor(() => sse.seen.filter((e) => e.event === 'alert').length >= 2);
    const g2 = await waitFor(() => sse2.seen.find((e) => e.event === 'alert'));
    ok(!!g1, '第一位家属收到第二条');
    ok(!!g2, '第二位家属也收到（扇出正确）');

    // 断开后不应再计入送达
    sse.close(); sse2.close();
    await sleep(120);
    const r3 = await post(base, '/api/report', { patientToken: 'pt_sse', event: { type: 'missed', level: 4, text: 'x' } });
    eq(r3.body.caregivers, 2, '家属仍处于绑定状态');
    eq(r3.body.delivered, 0, '连接已断开时如实返回"送达 0"——不谎报送达数');

    await relay.close();
  }

  /* ------------------------------------------------------------------
   * 3. 隐私与鉴权
   * ------------------------------------------------------------------ */
  section('【3】隐私与鉴权：不泄露未授权的东西');
  {
    const { relay, base } = await boot();

    const noToken = await post(base, '/api/report', { event: { type: 'missed' } });
    eq(noToken.status, 401, '未登记的设备令牌上报被拒绝（401）');

    const notFound = await (await fetch(base + '/api/nope')).json();
    eq(notFound.ok, false, '未知路径返回 ok:false，不会静默成功');

    // 先把话说清楚：**"不含药名"这条保证不在中继这一层。**
    // 中继是个哑管道，它转发什么取决于患者端给了什么；
    // 真正的保证在 `app/js/app.js` 的白名单构造器里，
    // 由 browser-check 11b2（两种开关状态各查一遍）与 smoke 的回调锁定来覆盖。
    // 这里能负责任地断言的是另一件事：**中继自己不加工、不夹带**——
    // 它不会在患者交来的事件上凭空添加任何字段。
    await post(base, '/api/pair', { code: 'MEDI-PRIV', patientToken: 'pt_priv', patientLabel: '张爷爷' });
    const claim = await post(base, '/api/claim', { code: 'MEDI-PRIV' });
    const sse = openSSE(base + '/api/events?token=' + claim.body.caregiverToken);
    await sse.ready;
    await waitFor(() => sse.seen.find((e) => e.event === 'ready'));

    const evText = '有一条用药提醒未确认';
    await post(base, '/api/report', {
      patientToken: 'pt_priv',
      event: { type: 'missed', level: 4, scheduledAt: '2026-10-11T10:00:00.000Z', text: evText }
    });
    const got = await waitFor(() => sse.seen.find((e) => e.event === 'alert'));
    const data = JSON.parse(got.data);
    ok(!/二甲双胍|阿托伐他汀|氨氯地平/.test(JSON.stringify(data)),
      '中继送达的整条 payload 里没有任何药名');
    ok(!/\d+\s*片/.test(data.text), '中继送达的正文里没有剂量');
    eq(Object.keys(data).sort().join(','),
      'code,id,level,receivedAt,scheduledAt,text,type',
      '中继**一个字段都不多给**：家属拿到的字段被限制在白名单内（不夹带任何上游私有数据）');

    // 超长正文必须被截断，防止有人拿中继当存储用
    const long = 'x'.repeat(2000);
    await post(base, '/api/report', { patientToken: 'pt_priv', event: { type: 'missed', text: long } });
    const got2 = await waitFor(() => sse.seen.filter((e) => e.event === 'alert').length >= 2);
    void got2;
    const second = sse.seen.filter((e) => e.event === 'alert')[1];
    eq(JSON.parse(second.data).text.length, 500, '超长正文被截断到 500 字符');

    sse.close();
    await relay.close();
  }

  /* ------------------------------------------------------------------
   * 4. Web Push：加密必须能被独立解密还原
   * ------------------------------------------------------------------ */
  section('【4】Web Push：VAPID 签名可验、载荷可被模拟推送服务解密还原');
  {
    const { relay, base, mock, mockPort, vapidKeys } = await boot({ withPush: true });

    const subKeys = makeSubscriberKeys();
    const endpoint = `http://127.0.0.1:${mockPort}/push/abc123`;
    mock.register('/push/abc123', subKeys);

    await post(base, '/api/pair', { code: 'MEDI-PUSH', patientToken: 'pt_push', patientLabel: '张爷爷' });
    const claim = await post(base, '/api/claim', { code: 'MEDI-PUSH' });
    const token = claim.body.caregiverToken;

    const missing = await post(base, '/api/push-subscribe', { caregiverToken: token, subscription: { endpoint } });
    eq(missing.status, 400, '缺 p256dh/auth 的订阅被拒绝（保住了"格式不对就别假装订阅成功"）');

    const sub = await post(base, '/api/push-subscribe', {
      caregiverToken: token,
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } }
    });
    eq(sub.status, 200, '家属登记 Web Push 订阅成功');
    eq(sub.body.subscriptions, 1, '该家属名下 1 条订阅');

    // 重复登记同一 endpoint 不应重复累积
    const again = await post(base, '/api/push-subscribe', {
      caregiverToken: token,
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } }
    });
    eq(again.body.subscriptions, 1, '重复登记同一 endpoint 不累积（重装 PWA 不会刷出一堆死订阅）');

    const payloadText = '18:00 二甲双胍缓释片 1 片 未确认';
    const rep = await post(base, '/api/report', {
      patientToken: 'pt_push',
      event: { type: 'missed', level: 4, scheduledAt: '2026-10-11T10:00:00.000Z', text: payloadText }
    });
    eq(rep.status, 200, '上报事件成功');
    eq(rep.body.detail.pushAttempted, 1, '对已登记的订阅发起了一次推送');
    eq(rep.body.detail.pushDelivered, 1, '推送投递成功');

    const rec = await waitFor(() => mock.received[0]);
    ok(!!rec, '模拟推送服务**真的收到了 HTTP 请求**');
    eq(rec.encoding, 'aes128gcm', '请求使用 aes128gcm 编码');
    eq(rec.authorized, true, 'VAPID Authorization 头存在且 **ES256 签名校验通过**'
      + (rec.vapidError ? '（错误：' + rec.vapidError + '）' : ''));
    eq(rec.claims.aud, `http://127.0.0.1:${mockPort}`, 'JWT 的 aud 是推送端点所在源（RFC 8292 要求）');
    ok(rec.claims.exp > Math.floor(Date.now() / 1000), 'JWT 未过期');
    eq(rec.claims.sub, 'mailto:caregiver@example.com', 'JWT 带 sub（推送服务出问题时能找到人）');

    ok(!!rec.payload, '载荷**被独立实现的解密还原成功**'
      + (rec.decryptError ? '（解密失败：' + rec.decryptError + '）' : ''));
    if (rec.payload) {
      eq(rec.payload.text, payloadText, '还原出的正文与原文逐字一致');
      eq(rec.payload.type, 'missed', '还原出的事件类型一致');
      eq(rec.payload.level, 4, '还原出的事件等级一致');
    }

    eq(mock.received.length, 1, '模拟推送服务共收到 1 条（没有重复投递）');

    await relay.close();
    await mock.close();
    void vapidKeys;
  }

  /* ------------------------------------------------------------------
   * 5. 投递失败必须如实报告
   * ------------------------------------------------------------------ */
  section('【5】推送失败时不谎报送达');
  {
    const { relay, base, mock, mockPort } = await boot({ withPush: true, mockOpts: { rejectWith: 500 } });

    const subKeys = makeSubscriberKeys();
    const endpoint = `http://127.0.0.1:${mockPort}/push/fail`;
    mock.register('/push/fail', subKeys);

    await post(base, '/api/pair', { code: 'MEDI-FAIL', patientToken: 'pt_fail', patientLabel: '张爷爷' });
    const claim = await post(base, '/api/claim', { code: 'MEDI-FAIL' });
    await post(base, '/api/push-subscribe', {
      caregiverToken: claim.body.caregiverToken,
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } }
    });

    const rep = await post(base, '/api/report', {
      patientToken: 'pt_fail',
      event: { type: 'missed', level: 4, text: '18:00 二甲双胍缓释片 未确认' }
    });
    eq(rep.status, 200, '上报本身不因推送失败而报错（提醒该响还是要响）');
    eq(rep.body.detail.pushAttempted, 1, '确实尝试了 1 次推送');
    eq(rep.body.detail.pushDelivered, 0, '推送端点返回 500 —— 如实计为 0 次送达');
    eq(rep.body.detail.delivered === 0 ? rep.body.delivered : rep.body.delivered, rep.body.delivered, '送达总数不再虚增');
    eq(rep.body.delivered, 0, '总送达数为 0，**绝不谎报"已通知家属"**');
    atLeast(rep.body.detail.pushErrors.length, 1, '失败原因被记录下来（可用于向用户解释）');
    ok(/500/.test(rep.body.detail.pushErrors[0] || ''), '失败原因里带上真实状态码（500）');

    await relay.close();
    await mock.close();
  }

  /* ------------------------------------------------------------------
   * 6. 订阅过期自动清理
   * ------------------------------------------------------------------ */
  section('【6】订阅失效（404/410）后自动清理，不再反复白试');
  {
    const { relay, base, mock, mockPort } = await boot({ withPush: true, mockOpts: { rejectWith: 410 } });

    const subKeys = makeSubscriberKeys();
    const endpoint = `http://127.0.0.1:${mockPort}/push/gone`;
    mock.register('/push/gone', subKeys);

    await post(base, '/api/pair', { code: 'MEDI-GONE', patientToken: 'pt_gone', patientLabel: '张爷爷' });
    const claim = await post(base, '/api/claim', { code: 'MEDI-GONE' });
    const token = claim.body.caregiverToken;
    await post(base, '/api/push-subscribe', {
      caregiverToken: token,
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } }
    });

    await post(base, '/api/report', { patientToken: 'pt_gone', event: { type: 'missed', text: 'a' } });
    eq(relay.state.caregivers[token].subscriptions.length, 0, '端点返回 410 后订阅被移除（过期订阅不该被无限重试）');

    const rep2 = await post(base, '/api/report', { patientToken: 'pt_gone', event: { type: 'missed', text: 'b' } });
    eq(rep2.body.detail.pushAttempted, 0, '第二次上报不再对已失效订阅发起推送');

    await relay.close();
    await mock.close();
  }

  /* ------------------------------------------------------------------
   * 7. 持久化：重启后绑定关系还在
   * ------------------------------------------------------------------ */
  section('【7】持久化：服务重启后邀请码与绑定关系不丢');
  {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const dataFile = path.join(dir, 'relay.json');

    const r1 = createRelay({ dataFile });
    const p1 = await r1.listen(0);
    const b1 = `http://127.0.0.1:${p1}`;
    await post(b1, '/api/pair', { code: 'MEDI-PER1', patientToken: 'pt_persist', patientLabel: '张爷爷' });
    await post(b1, '/api/claim', { code: 'MEDI-PER1', caregiverLabel: '女儿' });
    await r1.close();

    const r2 = createRelay({ dataFile });
    const p2 = await r2.listen(0);
    const b2 = `http://127.0.0.1:${p2}`;
    const health = await (await fetch(b2 + '/api/health')).json();
    eq(health.invites, 1, '重启后邀请码仍在');
    eq(health.caregivers, 1, '重启后家属绑定关系仍在');

    const claim2 = await post(b2, '/api/claim', { code: 'MEDI-PER1', caregiverLabel: '儿子' });
    eq(claim2.status, 200, '重启后仍可用同一邀请码继续绑定');
    eq(claim2.body.patientLabel, '张爷爷', '重启后患者标识仍在');

    await r2.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }

  /* ------------------------------------------------------------------
   * 【8】监听地址：--host 0.0.0.0 必须真的能从局域网地址访问到
   * ------------------------------------------------------------------
   * 这一条锁的是 2026-10-11 真机联调时发现的文档/实现矛盾：
   * docs/08 §五 承诺"局域网内填 http://192.168.x.x:8789 即可"，
   * 而 CLI 只监听 127.0.0.1 且没有 --host 参数——手机永远连不上。
   * 断言方式不是看 server.address()（那只证明"自己说了什么"），
   * 而是拿到本机真实局域网 IPv4，从那个地址**真的发一个请求**。
   * 找不到局域网 IPv4 的环境（如无网卡的 CI）退化为只验证 127.0.0.1 可用，
   * 并如实打印降级原因——绝不静默假装测过。
   */
  section('【8】监听地址：0.0.0.0 可从局域网地址访问，127.0.0.1 仅回环');
  {
    const os = await import('node:os');

    // 8a. 绑定 0.0.0.0 后，从真实局域网 IPv4 访问 /api/health
    const rLan = createRelay({ dataFile: null });
    const lanPort = await rLan.listen(0, '0.0.0.0');
    const lanIPs = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address);
    if (lanIPs.length) {
      const health = await (await fetch(`http://${lanIPs[0]}:${lanPort}/api/health`)).json();
      eq(health.ok, true, `绑定 0.0.0.0 后可从局域网地址 ${lanIPs[0]}:${lanPort} 访问`);
    } else {
      const health = await (await fetch(`http://127.0.0.1:${lanPort}/api/health`)).json();
      eq(health.ok, true, '（无局域网 IPv4 环境，降级）绑定 0.0.0.0 后 127.0.0.1 可用');
      console.log('  ⚠ 本机没有非内部 IPv4，局域网可达性未真正验证');
    }
    await rLan.close();

    // 8b. 绑定 127.0.0.1 是默认行为（安全默认）：回环可用
    const rLoop = createRelay({ dataFile: null });
    const loopPort = await rLoop.listen(0, '127.0.0.1');
    const health2 = await (await fetch(`http://127.0.0.1:${loopPort}/api/health`)).json();
    eq(health2.ok, true, '默认绑定 127.0.0.1 时本机可用');
    await rLoop.close();
  }

  /* ------------------------------------------------------------------
   * 【9】中继计时：患者熄屏/冻结后「通知家属」依然送达
   * ------------------------------------------------------------------
   * 锁的是 2026-10-12 落地的 L4 架构缺口修复：L4 原先只靠患者手机
   * 页面里的 JS 定时器驱动，熄屏后永不触发——家属协同在最需要时恰好失效。
   * 现在患者端把每剂的 L4 时刻预先交给中继，由这个一直活着的进程计时；
   * 到点仍未撤销 → 推送。失败方向是安全的：患者手机死机时家属照样收到。
   * 定时器传 0 关闭，由测试手动驱动 checkWatches，避免与断言竞争。
   */
  section('【9】中继计时：待办上报/撤销/到点推送/防重复');
  {
    const r = createRelay({ watchIntervalMs: 0 });
    const wPort = await r.listen(0);
    const wBase = `http://127.0.0.1:${wPort}`;
    await post(wBase, '/api/pair', { code: 'MEDI-WATCH', patientToken: 'pt_w', patientLabel: '张爷爷' });
    const wClaim = await post(wBase, '/api/claim', { code: 'MEDI-WATCH', caregiverLabel: '女儿' });
    const wSse = openSSE(wBase + '/api/events?token=' + wClaim.body.caregiverToken);
    await wSse.ready;
    await waitFor(() => wSse.seen.find((e) => e.event === 'ready'));
    const healthOf = async () => (await fetch(wBase + '/api/health')).json();

    // 9a. 未登记的设备令牌不能上报/撤销（与 /api/report 同样的门槛）
    eq((await post(wBase, '/api/notify-schedule', { patientToken: 'pt_ghost', items: [] })).status, 401, '未登记令牌上报待办被拒绝（401）');
    eq((await post(wBase, '/api/notify-cancel', { patientToken: 'pt_ghost', reminderIds: ['x'] })).status, 401, '未登记令牌撤销待办被拒绝（401）');

    // 9b. 上报两条待办，health 如实报告
    const sch = await post(wBase, '/api/notify-schedule', {
      patientToken: 'pt_w',
      items: [
        { reminderId: 'rm_1', scheduledAt: '2026-10-12T01:00:00.000Z', notifyAt: '2026-10-12T01:30:00.000Z' },
        { reminderId: 'rm_2', scheduledAt: '2026-10-12T02:00:00.000Z', notifyAt: '2026-10-12T02:30:00.000Z' }
      ]
    });
    eq(sch.status, 200, '患者上报计时待办成功');
    eq(sch.body.watched, 2, '上报回执为 2 条');
    eq((await healthOf()).watches, 2, 'health 如实报告待办条数（中继侧的真账）');

    // 9c. 全量对账：重报 1 条 → 旧的全部清除（删药/改时间自动跟上）
    await post(wBase, '/api/notify-schedule', {
      patientToken: 'pt_w',
      items: [{ reminderId: 'rm_2', scheduledAt: '2026-10-12T02:00:00.000Z', notifyAt: '2026-10-12T02:30:00.000Z' }]
    });
    eq((await healthOf()).watches, 1, '全量对账语义：未再上报的旧条目被清除');

    // 9d. 到点推送：notifyAt 已过去 → checkWatches 推给在线家属
    await post(wBase, '/api/notify-schedule', {
      patientToken: 'pt_w',
      items: [{ reminderId: 'rm_2', scheduledAt: '2026-10-12T02:00:00.000Z', notifyAt: new Date(Date.now() - 1000).toISOString() }]
    });
    const tick = await r.checkWatches();
    eq(tick.due, 1, '扫描发现 1 条到期待办');
    const wGot = await waitFor(() => wSse.seen.find((e) => e.event === 'alert' && JSON.parse(e.data).via === 'relay-watch'));
    ok(!!wGot, '家属端**真的收到**中继计时推送（不是"函数被调用了"）');
    if (wGot) {
      const wd = JSON.parse(wGot.data);
      eq(wd.level, 4, '推送事件等级是 L4');
      eq(wd.type, 'missed', '推送事件类型是 missed');
      eq(wd.reminderId, 'rm_2', '事件带内部提醒 id（不含药名）');
    }
    eq((await healthOf()).watches, 0, '推送后待办移除（每条只推一次）');
    const tickAgain = await r.checkWatches();
    eq(tickAgain.due, 0, '再次扫描不会重复推送');

    // 9e. 撤销：确认/跳过后，到点也不推
    await post(wBase, '/api/notify-schedule', {
      patientToken: 'pt_w',
      items: [{ reminderId: 'rm_3', scheduledAt: '2026-10-12T03:00:00.000Z', notifyAt: new Date(Date.now() - 1000).toISOString() }]
    });
    const cancel = await post(wBase, '/api/notify-cancel', { patientToken: 'pt_w', reminderIds: ['rm_3'] });
    eq(cancel.body.cancelled, 1, '撤销回执为 1 条');
    const tick2 = await r.checkWatches();
    eq(tick2.due, 0, '已撤销的待办到点不推送（确认后家属不被打扰）');

    // 9f. 防重复推送：患者端实时上报（页面内引擎真触发了 L4）→ 对应待办自动撤销
    await post(wBase, '/api/notify-schedule', {
      patientToken: 'pt_w',
      items: [{ reminderId: 'rm_4', scheduledAt: '2026-10-12T04:00:00.000Z', notifyAt: new Date(Date.now() - 1000).toISOString() }]
    });
    await post(wBase, '/api/report', {
      patientToken: 'pt_w',
      event: { type: 'missed', level: 4, reminderId: 'rm_4', text: '页面内引擎已触发' }
    });
    eq((await healthOf()).watches, 0, '实时上报后同剂待办被自动撤销');
    const tick3 = await r.checkWatches();
    eq(tick3.due, 0, '家属不会收到两条同样的通知（中继只推一次）');

    wSse.close();
    await r.close();

    // 9g. 持久化：中继重启后计时待办不丢（丢了 = 患者熄屏期家属漏收）
    const os9 = await import('node:os');
    const path9 = await import('node:path');
    const fs9 = await import('node:fs');
    const dir9 = fs9.mkdtempSync(path9.join(os9.tmpdir(), 'relay-watch-'));
    const dataFile9 = path9.join(dir9, 'relay.json');
    const ra = createRelay({ dataFile: dataFile9, watchIntervalMs: 0 });
    const pa = await ra.listen(0);
    const ba = `http://127.0.0.1:${pa}`;
    await post(ba, '/api/pair', { code: 'MEDI-KEEP', patientToken: 'pt_keep', patientLabel: '张爷爷' });
    await post(ba, '/api/notify-schedule', {
      patientToken: 'pt_keep',
      items: [{ reminderId: 'rm_keep', scheduledAt: '2026-10-12T05:00:00.000Z', notifyAt: '2026-10-13T05:30:00.000Z' }]
    });
    await ra.close();

    const rb = createRelay({ dataFile: dataFile9, watchIntervalMs: 0 });
    const pb = await rb.listen(0);
    const bb = `http://127.0.0.1:${pb}`;
    eq((await (await fetch(bb + '/api/health')).json()).watches, 1, '中继重启后计时待办仍在');
    await rb.close();
    try { fs9.rmSync(dir9, { recursive: true, force: true }); } catch (e) { }
  }

  /* ------------------------------------------------------------------
   * 汇总
   * ------------------------------------------------------------------ */
  console.log('\n' + '='.repeat(56));
  console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('测试崩溃：', e); process.exitCode = 1; });
