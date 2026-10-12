#!/usr/bin/env node
/**
 * browser-check.mjs — 真实浏览器端到端检查
 *
 * 为什么需要它：纯 Node 测试用 vm 沙箱只加载 scheduler/store/reminder，
 * 碰不到 app.js 与 platform.js 里的 DOM 与启动链路。只有真的把页面跑起来，
 * 才能发现「Platform is not defined」这类一启动就白屏的错误。
 *
 * 做法：以无头模式启动 Edge/Chrome，通过 CDP（Chrome DevTools Protocol）
 * 打开应用、收集 JS 异常、断言界面与状态、并保存整屏截图。
 *
 * 运行：node tests/browser-check.mjs [--port 8788] [--shot <目录>]
 * 前置：另开一个终端在 app/ 下起静态服务器
 *       python -m http.server 8788 --bind 127.0.0.1
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createRelay } from '../../server/relay.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('--port', '8788');
const SHOT_DIR = arg('--shot', join(tmpdir(), 'mediontime-shots'));
const DEBUG_PORT = arg('--debugPort', '9333');
const BASE = `http://127.0.0.1:${PORT}/index.html`;

/**
 * 从服务器上真实的 sw.js 里读出「缓存名 + 资源清单」。
 * 之前在测试里另抄了一份清单，结果是两份会各自漂移：
 * 往 sw.js 里加文件而忘了改测试，测试就会去断言一个已经不存在的世界。
 * 现在清单只有一个来源，测试只做核对。
 */
async function readSwInfo() {
  const src = await (await fetch(new URL('sw.js', BASE).href)).text();
  const cache = /const\s+CACHE\s*=\s*'([^']+)'/.exec(src);
  const assets = /const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!cache || !assets) throw new Error('无法从 sw.js 解析 CACHE / ASSETS —— sw.js 结构变了？');
  const list = (assets[1].match(/'[^']+'/g) || []).map(s => s.slice(1, -1));
  if (!list.length) throw new Error('sw.js 的 ASSETS 解析为空');
  return { cache: cache[1], assets: list };
}

/* ---------- 定位浏览器 ---------- */
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];
const BROWSER = CANDIDATES.find(p => existsSync(p));
if (!BROWSER) {
  console.error('✗ 未找到可用的 Chrome / Edge 可执行文件');
  process.exit(2);
}
mkdirSync(SHOT_DIR, { recursive: true });
const PROFILE = join(tmpdir(), 'mediontime-cdp-profile-' + Date.now());

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function ok(c, name) { eq(!!c, true, name); }
function has(text, needle, name) {
  const t = String(text == null ? '' : text);
  if (t.indexOf(needle) !== -1) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      未包含: ${needle}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ---------- CDP 客户端 ---------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDevtools(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

async function main() {
  console.log(`浏览器：${BROWSER}`);
  const proc = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`, '--window-size=460,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, msgId = 0;
  const pending = new Map();
  const errors = [];

  function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
    });
  }

  async function evaluate(expr) {
    // 用 async 包装并把表达式 await 掉，使同步表达式与返回 Promise 的表达式
    // 都能被正确取回；顶层返回 Promise 时 awaitPromise 才会真正等待。
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){ try { return { value: await (${expr}) }; } catch(e) { return { error: String((e && e.message) || e) }; } })()`,
      returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    const v = r.result && r.result.value;
    if (v && v.error) return { error: v.error };
    return { value: v ? v.value : undefined };
  }

  async function goto(url, waitMs = 1200) {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  }

  /**
   * 对选择器命中的元素发出**真实鼠标点击**（先滚进视野再取屏幕坐标）。
   * 为什么不用 element.click()：它不移动焦点、不产生 hover、也不检查元素是否被遮挡，
   * 拿它验证"点了会发生什么"会得到假阳性。这一点在无障碍那套测试里已经吃过一次亏。
   * 返回 false 表示元素不存在或尺寸为 0（调用方应据此判定失败，而不是静默继续）。
   */
  async function clickSel(selector) {
    const box = await evaluate(`(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { zero: true };
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box.value || box.value.zero) return false;
    const { x, y } = box.value;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  async function shot(name, viewportHeight = 900, phoneHeight = null) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 460, height: viewportHeight, deviceScaleFactor: 2, mobile: true
    });
    if (phoneHeight) {
      await evaluate(`(function(){var p=document.getElementById('phone'); if(p) p.style.height='${phoneHeight}px'; return true;})()`);
      await sleep(150);
    }
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOT_DIR, name + '.png');
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`    · 截图 ${file}`);
  }

  try {
    const target = await waitForDevtools();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push('未捕获异常：' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('console.error：' + m.params.args.map(a => a.value ?? a.description).join(' '));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        // 把 URL 一并记下来：只说"有个 404"而不说"哪个 URL 404"，
        // 排查时只能靠猜——而猜正是这套测试存在的理由的反面。
        errors.push('浏览器日志：' + m.params.entry.text +
          (m.params.entry.url ? '  ← ' + m.params.entry.url : ''));
      }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    /* ========== 1. 启动与全局对象 ========== */
    section('【1. 启动与全局对象】');
    await goto(BASE + '?auto=1&page=today');
    let r = await evaluate(`typeof Platform + '|' + typeof Scheduler + '|' + typeof Store + '|' + typeof App`);
    eq(r.value, 'object|object|object|object', '四个模块都已加载（platform.js 已接入）');

    r = await evaluate(`Platform.get().id`);
    eq(r.value, 'web', '浏览器环境下解析为 web 平台');

    r = await evaluate(`Store.state.reminders.length > 0`);
    eq(r.value, true, '排程已生成');

    r = await evaluate(`document.querySelectorAll('.tab').length`);
    eq(r.value, 4, '底部导航渲染出 4 个页签');

    r = await evaluate(`JSON.stringify(Platform.diagnose({permission:'granted'}).checks.map(c=>c.level))`);
    eq(r.value, JSON.stringify(['ok', 'bad', 'bad', 'warn']),
      'Web 环境可靠性自检如实报告 2 项不通过（未粉饰限制）');

    /* ========== 2. 今日页 ========== */
    section('【2. 今日页】');
    r = await evaluate(`document.querySelectorAll('.dose').length`);
    ok(r.value >= 3, '今日时间轴渲染出多条用药安排');

    r = await evaluate(`document.body.innerText.indexOf('漏服了怎么办') !== -1`);
    eq(r.value, true, '漏服补救入口可见');

    /* ========== 3. 设置页：提醒可靠性 ========== */
    section('【3. 设置页 · 提醒可靠性】');
    await goto(BASE + '?auto=1&page=me');
    r = await evaluate(`!!document.getElementById('syncHeadline')`);
    eq(r.value, true, '可靠性卡片已渲染');
    r = await evaluate(`document.getElementById('syncHeadline').textContent`);
    eq(r.value, '页面内提醒', 'Web 下如实显示为「页面内提醒」而非谎报已托管');
    const body = (await evaluate(`document.getElementById('syncBody').textContent`)).value || '';
    has(body, '系统级闹钟', '列出「系统级闹钟」检查项');
    has(body, '应用被关闭后仍能提醒', '列出「应用被关闭后仍能提醒」检查项');
    has(body, '重新同步', '提供「重新同步」操作');
    has(body, '查看详情', '提供「查看详情」操作');
    ok(body.indexOf('已优先保证最近') === -1,
      'Web 环境不展示虚假的"已保证 N 条"承诺');
    has(body, '只有应用处于打开状态时才会响铃', '如实说明 Web 环境的真实限制');

    r = await evaluate(`(function(){ App.showDiag(); return document.getElementById('sheet').textContent; })()`);
    has(r.value, '提醒可靠性详情', '详情弹层可打开');
    has(r.value, '运行环境', '详情中说明运行环境');
    has(r.value, '浏览器', '详情中如实说明是浏览器环境');
    await evaluate(`App.closeSheet()`);

    await shot('me-reliability', 1500, 1400);

    /* ========== 4. 同步链路 ========== */
    section('【4. 系统闹钟同步链路】');
    r = await evaluate(`(function(){ return new Promise(function(res){ App.resync(); setTimeout(function(){ res(true); }, 300); }); })()`);
    ok(!r.error, '触发同步无异常');
    r = await evaluate(`document.getElementById('syncHeadline').textContent`);
    eq(r.value, '页面内提醒', 'Web 环境同步后仍如实显示为页面内提醒');

    /* ========== 5. 时区二选一流程 ========== */
    section('【5. 时区变化二选一】');
    await goto(BASE + '?auto=1&simTz=UTC-11', 1800);
    r = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
    eq(r.value, true, '检测到时区变化后自动弹出确认层');
    const sheet = (await evaluate(`document.getElementById('sheet').textContent`)).value || '';
    has(sheet, '检测到时区变化', '标题正确');
    has(sheet, 'UTC-11', '显示原时区');
    has(sheet, '按当地钟点服药', '提供「按当地钟点」选项');
    has(sheet, '保持原有服药间隔', '提供「保持原有间隔」选项');
    has(sheet, '不会替你改处方', '明确声明不代替用户决策');
    has(sheet, '02:00', '给出保持间隔后的具体钟点（07:00 → 02:00）');
    await shot('tz-prompt', 1000, 900);

    // 选择「保持原有服药间隔」，验证处方真的被平移
    const before = (await evaluate(`JSON.stringify(Store.state.plans.filter(p=>p.isActive&&p.anchorType!=='relative').map(p=>p.times))`)).value;
    r = await evaluate(`(function(){ App.tzChoose('keep_rhythm'); return Store.state.user.tzPolicy; })()`);
    eq(r.value, 'keep_rhythm', '选择后策略被写入用户设置');
    const after = (await evaluate(`JSON.stringify(Store.state.plans.filter(p=>p.isActive&&p.anchorType!=='relative').map(p=>p.times))`)).value;
    ok(before !== after, '选择「保持间隔」后处方时间点确实发生平移');
    r = await evaluate(`Scheduler.detectTimezoneChange(Store.state.user.timezone).changed`);
    eq(r.value, false, '确认后不再重复提示时区变化');
    r = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
    eq(r.value, false, '选择后确认层自动关闭');

    r = await evaluate(`Store.state.plans.find(p=>p.id==='p_aml').times.join(',')`);
    eq(r.value, '02:00', 'UTC-11 → UTC+08 后，原 07:00 平移到当地 02:00（与弹层提示一致）');

    /* ========== 6. 排程页 ========== */
    section('【6. 平移后重算排程】');
    await goto(BASE + '?auto=1&page=plan');
    r = await evaluate(`document.querySelectorAll('#screen .card .badge').length`);
    ok(r.value > 0, '平移后重新生成了提醒（排程页渲染出提醒条目）');
    r = await evaluate(`document.body.innerText.indexOf('02:00') !== -1`);
    eq(r.value, true, '排程页可见平移后的钟点 02:00（改写真的落到了界面上）');
    r = await evaluate(`document.body.innerText.indexOf('16:00') !== -1`);
    eq(r.value, true, '原睡前 21:00 也正确平移为 16:00');
    r = await evaluate(`Store.state.reminders.filter(x=>x.status==='pending').length > 0`);
    eq(r.value, true, '仍有待触发提醒');

    /* ========== 7. BR-08 危险操作独立二次确认 ========== */
    section('【7. BR-08 危险操作独立二次确认】');
    await goto(BASE + '?auto=1&page=me');

    // 7.1 逐个关掉，只剩最后一个时不应弹确认
    r = await evaluate(`(function(){
      ['sound','fullscreen','caregiver'].forEach(function(k){ if(Store.state.user.channels[k]) App.toggleChannel(k); });
      return JSON.stringify(Store.state.user.channels);
    })()`);
    const chans = JSON.parse(r.value);
    eq(chans.sound, false, '关闭「提示音与震动」无需二次确认');
    eq(chans.fullscreen, false, '关闭「全屏强提醒」无需二次确认');
    eq(chans.caregiver, false, '关闭「通知家属」无需二次确认');
    eq(chans.notification, true, '此时系统通知仍开启（还剩最后一个渠道）');

    // 7.2 关最后一个 → 必须弹独立确认，且此刻尚未生效
    // 注意：evaluate 把表达式塞进 await (...)，多语句必须包成 IIFE
    r = await evaluate(`(function(){ App.toggleChannel('notification'); return document.getElementById('overlay').classList.contains('show'); })()`);
    eq(r.value, true, '关闭最后一个提醒渠道时弹出独立二次确认');
    r = await evaluate(`document.getElementById('sheet').innerText`);
    has(r.value, '关闭全部提醒', '确认层标题点明是「关闭全部提醒」');
    has(r.value, '不会再有任何服药提醒', '确认层写清了后果，不是一句「确定吗」');
    has(r.value, '保持原样', '取消按钮明确表达「取消 = 不变更」');
    r = await evaluate(`Store.state.user.channels.notification`);
    eq(r.value, true, '确认之前渠道状态未被改动（不是先改后问）');

    // 7.3 取消 → 保持原样
    await evaluate(`App.closeSheet()`);
    await sleep(150);
    r = await evaluate(`Store.state.user.channels.notification`);
    eq(r.value, true, '取消后保持原样');

    // 7.4 再次操作并确认 → 才真正生效
    await evaluate(`App.toggleChannel('notification')`);
    await evaluate(`document.getElementById('dlgDanger').click()`);
    await sleep(200);
    r = await evaluate(`Store.state.user.channels.notification`);
    eq(r.value, false, '确认之后才真正关闭');

    // 直接写状态恢复渠道，避免触发权限请求等副作用
    await evaluate(`(function(){ Store.updateUser({channels:{notification:true,sound:true,fullscreen:true,caregiver:true}}); return true; })()`);

    // 7.5 修改剂量 → 必须二次确认，且写明改动前后
    await evaluate(`App.editMedicine('m_aml')`);
    await sleep(200);
    r = await evaluate(`Store.state.plans.find(p=>p.id==='p_aml').doseAmount`);
    const doseBefore = r.value;
    await evaluate(`(function(){ App.setField('doseAmount', ${doseBefore + 1}); return true; })()`);
    await evaluate(`App.saveMedicine()`);
    await sleep(250);
    r = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
    eq(r.value, true, '修改剂量时弹出独立二次确认');
    r = await evaluate(`document.getElementById('sheet').innerText`);
    has(r.value, '确认修改剂量', '确认层标题点明是「确认修改剂量」');
    has(r.value, '剂量属于处方内容', '确认层说明剂量属于处方内容');
    r = await evaluate(`Store.state.plans.find(p=>p.id==='p_aml').doseAmount`);
    eq(r.value, doseBefore, '确认之前计划剂量未被改写');
    await evaluate(`document.getElementById('dlgDanger').click()`);
    await sleep(250);
    r = await evaluate(`Store.state.plans.find(p=>p.id==='p_aml').doseAmount`);
    eq(r.value, doseBefore + 1, '确认之后剂量才真正改写');

    /* ========== 8. Service Worker 真实安装 ========== */
    section('【8. Service Worker 真实安装】');
    // 缓存名与资源清单从服务器上真实的 sw.js 里读，不在测试里另抄一份
    const swInfo = await readSwInfo();
    // 为什么单独测这一组：sw.js 装不上时，页面一切正常、控制台也可能干净，
    // 只有离线缓存静默失效——而且安装失败态会拖住嵌它的宿主面板
    // （WorkBuddy 的 HTML 预览就曾因此一直停在「启动本地预览服务器」）。
    // pwa.test.cjs 用 node:vm 跑的是假环境，这里要的是真浏览器的真实结论。
    r = await evaluate(`window.self === window.top`);
    eq(r.value, true, '本页是顶层文档（SW 守卫只在被 iframe 嵌入时跳过注册）');

    let swReg = null;
    for (let i = 0; i < 20; i++) {
      r = await evaluate(`(async () => {
        const rs = await navigator.serviceWorker.getRegistrations();
        if (!rs.length) return { count: 0, state: null };
        const g = rs[0];
        return { count: rs.length, state: (g.installing || g.waiting || g.active || {}).state || null };
      })()`);
      swReg = r.value;
      if (swReg && (swReg.state === 'activated' || swReg.state === 'redundant')) break;
      await sleep(400);
    }
    eq(swReg && swReg.count, 1, 'Service Worker 注册成功（注册数 = 1）');
    eq(swReg && swReg.state, 'activated', 'Service Worker 已激活（未停在 installing）');

    r = await evaluate(`(async () => (await caches.keys()).join(','))()`);
    has(r.value, swInfo.cache, 'CacheStorage 中已建好 ' + swInfo.cache + ' 缓存');

    // 清单和缓存名都从**服务器上真实的 sw.js** 里读出来，不在这里另抄一份：
    // 抄一份的下场是"改了 sw.js 忘了改测试"，于是测试开始断言一个已经不存在的世界。
    r = await evaluate(`(async () => {
      const c = await caches.open(${JSON.stringify(swInfo.cache)});
      const want = ${JSON.stringify(swInfo.assets)};
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      const miss = [];
      for (const w of want) {
        const res = await c.match(new URL(w, base).href);
        if (!res) miss.push(w);
      }
      return { total: (await c.keys()).length, miss };
    })()`);
    // 只断言「清单里的每一项一个没漏」，不断言总数：
    // fetch 处理器会在缓存未命中时回写，于是带着调试查询串访问过的
    // index.html?page=xxx 也会各占一条；写死数量会被这种无关访客搅黄。
    // 而当初真正出问题（install 整个 reject）时，表现正是"清单里全都没进去"。
    eq(r.value && r.value.miss, [], `install 清单的 ${swInfo.assets.length} 个资源全部入缓存，一个都没漏`);

    /* ========== 9. 自适应轮询与到点触发（省电） ========== */
    section('【9. 自适应轮询与到点触发（省电）】');
    // 这一组补的是「start() 之后，唤醒时刻到底排得对不对」这条路径。
    // smoke/pwa 都只直接调 tick()，没有任何套件验证过真实的定时器——
    // 而它正是把「每秒轮询」改成「自适应唤醒」时唯一可能改坏的东西：
    // 排得对但永不醒来，测试照样全绿，用户却收不到提醒。
    await goto(BASE + '?auto=1&page=today');
    await sleep(700);

    // 这一组会真的触发震动，必须先让页面获得"用户激活"：
    // 无头环境默认没有手势，Chrome 会拒绝 navigator.vibrate 并写一条 error 级日志，
    // 把「无 JS 异常」那组的结论污染成假失败。
    // 真实用户必然先点过页面（首启必须勾选免责声明才能进入），所以这里补一个手势是还原真实条件。
    // 注意：手势会被导航重置，必须放在本组最后一次 goto 之后。
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 400, button: 'left', clickCount: 1 });
    await sleep(150);

    r = await evaluate(`ReminderEngine.isRunning()`);
    eq(r.value, true, '提醒引擎已启动并持有定时器');

    r = await evaluate(`ReminderEngine.lastDelay()`);
    eq(r.value, 300000, '空闲时单次只睡 5 分钟（不再是每秒轮询）');

    // 记下被武装的那条提醒的 id，后面按 id 精确观察它（不要靠排序猜）
    const armedId = await evaluate(`(async function(){
      Store.updateUser({ demoFast: true });
      ReminderEngine.reschedule();
      App.demoTrigger();            // 把最近一条待触发提醒改到 3 秒后
      var list = Store.state.reminders.filter(function(x){ return x.status === 'pending'; });
      list.sort(function(a,b){ return new Date(a.scheduledAt) - new Date(b.scheduledAt); });
      return list.length ? list[0].id : null;
    })()`);
    await sleep(150);
    r = await evaluate(`ReminderEngine.lastDelay()`);
    ok(r.value >= 2500 && r.value <= 3200, `排定的下次唤醒 ≈3 秒，精确对准那条提醒（实测 ${r.value}ms）`);

    await sleep(4200);
    r = await evaluate(`(function(){ var x = Store.findReminderById(${JSON.stringify(armedId.value)}); return x ? x.level : -1; })()`);
    ok(r.value >= 1, `到点后确实醒了过来并发出 L1（实测 level=${r.value}）—— 定时器不是摆设`);

    r = await evaluate(`ReminderEngine.lastDelay()`);
    ok(r.value > 3000 && r.value < 12000, `醒后自动排到加速后的下一级（5 分钟 ÷50 ≈ 6 秒，实测 ${r.value}ms）`);

    // 逾期的提醒在自适应轮询下也必须照样推进：直接改成 20 秒前，
    // 加速后 L1/L2/L3 均已过 → 应一次性推进到 L3 并弹全屏强提醒
    await evaluate(`(async function(){
      var p = Store.findReminderById(${JSON.stringify(armedId.value)});
      if (!p) return false;
      p.scheduledAt = new Date(Date.now() - 20000).toISOString();
      p.level = 0; p.fireAt = null; p.status = 'pending';
      Store.save();
      ReminderEngine.reschedule();
      return true;
    })()`);
    await sleep(500);
    r = await evaluate(`document.getElementById('fsAlert').classList.contains('show')`);
    eq(r.value, true, '逾期提醒在自适应唤醒下照样推进到 L3 并弹出全屏强提醒');
    r = await evaluate(`document.getElementById('fsAlert').getAttribute('aria-hidden')`);
    eq(r.value, 'false', '全屏提醒同时对辅助技术可见（aria-hidden=false）');
    await shot('09-adaptive-fullscreen', 900, 820);

    await evaluate(`(async function(){ Store.updateUser({ demoFast: false }); ReminderEngine.reschedule(); return true; })()`);

    /* ========== 10. 漏服状态在今日页是否可见 ==========
     * 起因：生成 UI 稿时截图显示 18:00 / 21:00 两剂只挂着「补服处理」按钮，
     * 而「已按时 / 延迟 / 已跳过」都有徽标。记录页对漏服用的是「漏服」徽标，
     * 两处不一致——最核心的状态恰恰是唯一没写出来的那个。
     *
     * 这里直接调用 Store.markMissed 造出「今日某一剂漏服」，
     * 而不是"把提醒挪到 3 小时前、再靠引擎判定成漏服"——后者会随运行时刻失效：
     * 在 00:2x 跑时「3 小时前」落在昨天，不在今日时间轴上，断言就假失败了。
     * 时间点也**不能写死**：前面第 5 组的时区策略已经平移过处方时间，
     * 写死 07:00 会造出一条匹配不到任何时间轴条目的提醒，同样假失败。
     * 所以用时间轴自己的算法（Scheduler.resolveScheduledAt）取时间点。
     * 漏服的判定逻辑本身由 scheduler / platform / smoke 覆盖，这里只验证**呈现**。
     * 放在流程末尾做，允许它污染状态，前面各组不受影响。 */
    section('【10. 漏服状态可见性】');
    r = await evaluate(`(async function(){
      var plan = Store.state.plans.filter(function (x) { return x.id === 'p_aml'; })[0];
      if (!plan || !plan.times || !plan.times.length) return null;
      var at = Scheduler.resolveScheduledAt(plan, new Date(), plan.times[0]);
      var rem = Store.ensureReminder(plan.id, at.toISOString());
      Store.markMissed(rem);
      Store.save();
      App.go('today');
      App.render();
      return rem.status;
    })()`);
    eq(r.value, 'missed', '已把今日一剂置为漏服（时间点取自时间轴，与运行时刻无关）');

    await sleep(200);
    r = await evaluate(`(function(){
      var els = document.querySelectorAll('#screen .dose');
      for (var i = 0; i < els.length; i++) {
        if (els[i].querySelector('.badge.bad')) return true;
      }
      return false;
    })()`);
    eq(r.value, true, '今日页对漏服一剂显示红色「漏服」徽标（此前只有按钮、无状态文字）');

    r = await evaluate(`(function(){
      var els = document.querySelectorAll('#screen .dose');
      for (var i = 0; i < els.length; i++) {
        var b = els[i].querySelector('.badge.bad');
        if (b && b.textContent.trim() === '漏服'
            && els[i].querySelector('.dose-cta.stack button')) return true;
      }
      return false;
    })()`);
    eq(r.value, true, '徽标文案为「漏服」，且同一行仍有可点的补救入口');

    r = await evaluate(`document.getElementById('screen').innerText.indexOf('漏服') !== -1`);
    eq(r.value, true, '「漏服」二字在今日页文本中可见（读屏器同样念得出）');

    /* ========== 11. 家属协同：接线到底接上了没有 ========== */
    section('【11. 家属协同真实投递（接线）】');
    // 为什么必须单独测这一组：
    //   server/tests/relay.test.mjs 证明的是"中继能把事件送到家属"，
    //   但**证明不了应用真的会把事件交给中继**——接线没接上时，
    //   两边各自的测试都会全绿，而家属一条也收不到。
    //   这正是本项目反复踩的那类坑：局部都对，整体不工作。
    {
      const relay = createRelay({});
      const relayPort = await relay.listen(0);
      const relayBase = `http://127.0.0.1:${relayPort}`;

      // 一个最小的家属端：连上 SSE，把收到的事件记下来
      const caregiverSeen = [];
      let caregiverReq = null;
      const openCaregiver = (token) => new Promise((resolve) => {
        caregiverReq = http.get(`${relayBase}/api/events?token=${token}`, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            buf += c;
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, i); buf = buf.slice(i + 2);
              const ev = {};
              frame.split('\n').forEach((l) => {
                if (l.startsWith('event: ')) ev.event = l.slice(7);
                else if (l.startsWith('data: ')) ev.data = (ev.data ? ev.data + '\n' : '') + l.slice(6);
              });
              if (ev.event) caregiverSeen.push(ev);
            }
          });
          resolve(res);
        });
      });

      // 把引擎推到 L4（该通知家属的那一级）：把一条待触发提醒挪到 31 分钟前。
      // 必须先把演示加速关掉——开启时升级间隔被压缩 50 倍，窗口也跟着缩到 72 秒，
      // 31 分钟的逾期会**直接越过窗口被判漏服**，L4 永远不会触发（本组第一版就栽在这）。
      const pushToL4 = async () => {
        await evaluate(`(function(){
          Store.updateUser({ demoFast: false, windowMinutes: 120, safetyGapMinutes: 120 });
          Store.updateUser({ channels: { notification: true, sound: true, fullscreen: true, caregiver: true } });
          document.getElementById('toast').textContent = '';   // 清掉上一条提示，免得读到别的用例留下的
          Store.regenerateReminders();
          var list = Store.state.reminders.filter(function(r){return r.status==='pending';})
            .sort(function(a,b){return a.scheduledAt<b.scheduledAt?-1:1;});
          if (!list.length) return 'no-pending';
          var r = list[0];
          r.scheduledAt = new Date(Date.now() - 31*60000).toISOString();
          r.level = 0;
          Store.save();
          ReminderEngine.tick();
          return 'ok';
        })()`);
        await sleep(800);   // 汇报是异步的，给它一点时间
      };

      /* ---- 11a. 未配置：必须一个请求都不发，也不能说"已通知" ---- */
      await evaluate(`(function(){
        Relay.unpair();
        Store.updateUser({ channels: { caregiver: true } });
        return true;
      })()`);
      await pushToL4();
      eq(relay.state.events.length, 0, '未配置服务器时，触发 L4 **一个事件都没有发出去**（"默认不联网"不是说说）');

      const toastUncfg = await evaluate(`(document.getElementById('toast').textContent||'')`);
      ok(/尚未配置|未通知/.test(toastUncfg.value || ''),
        `未配置时如实告知"没有通知任何人"（实际提示："${(toastUncfg.value || '').slice(0, 40)}…"）`);
      ok(!/已通知\s*\d+\s*位家属/.test(toastUncfg.value || ''),
        '**不再谎报"已通知 N 位家属"**（旧版本这里就是一句空话）');

      /* ---- 11b. 配置后：家属真的收到 ---- */
      const pairResult = await evaluate(`(async () => {
        try {
          const r = await Relay.pair(${JSON.stringify(relayBase)}, 'MEDI-E2E1', '张爷爷');
          return { ok: true, code: r.code };
        } catch (e) { return { ok: false, error: e.message }; }
      })()`);
      ok(pairResult.value && pairResult.value.ok,
        '患者端在真实浏览器里连上中继并登记邀请码'
        + (pairResult.value && pairResult.value.error ? '（失败：' + pairResult.value.error + '）' : ''));
      eq(relay.state.events === undefined ? null : Object.keys(relay.state.invites).length, 1,
        '中继侧确实收到了登记（沟通了两端，不是各说各话）');

      const claimRes = await (await fetch(relayBase + '/api/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'MEDI-E2E1', caregiverLabel: '女儿' })
      })).json();
      ok(!!claimRes.caregiverToken, '家属完成绑定');
      await openCaregiver(claimRes.caregiverToken);
      await sleep(200);
      ok(caregiverSeen.some(e => e.event === 'ready'), '家属端建立实时连接并收到 ready');

      await pushToL4();
      const got = caregiverSeen.find(e => e.event === 'alert');
      ok(!!got, '**家属端真的收到了漏服提醒**（这是"家属协同"从演示变成事实的那一步）');
      if (got) {
        const d = JSON.parse(got.data);
        eq(d.level, 4, '送达的事件是 L4（该通知家属的那一级）');
        ok(!!d.scheduledAt, '事件里带着该剂次的计划时间（家属能知道是哪一剂）');
        ok(/未确认/.test(d.text || ''), '事件正文说明"未确认"，而不是含糊的"有提醒"');
      }

      const toastOk = await evaluate(`(document.getElementById('toast').textContent||'')`);
      ok(/已送达\s*1\s*位家属/.test(toastOk.value || ''),
        `界面如实反馈送达数（实际提示："${(toastOk.value || '').slice(0, 40)}"）`);

      /* ---- 11b2. 泄漏探测器：默认配置下，药名到底有没有出门？ ----
       * 隐私政策（App.showPrivacy）、家属协同弹层（App.relaySetup）、家属端页面（caregiver.html）
       * 三处都写着「事件不含药名」。而 `hideDrugName` 的**默认值是 false**。
       * 所以真正该问的不是"开了隐私模式会怎样"（11d 问了），而是：
       *   **默认状态下，药名有没有离开这台设备？**
       *
       * 判定不看源码、也不看自己的断言，取两份独立证据：
       *   ① 患者端**真的发出去的字节**（把 window.fetch 包一层记下请求体）
       *   ② 中继**真的收到并落库**的那一条事件（relay.state.events）
       * 然后与药箱里**每一个**药名逐一比对。 */
      {
        // ① 记录"离开这台设备"的原始请求体
        await evaluate(`(function(){
          if (!window.__sentBodies) {
            window.__sentBodies = [];
            var orig = window.fetch;
            window.fetch = function (u, o) {
              try { if (o && o.body) window.__sentBodies.push({ url: String(u), body: String(o.body) }); } catch (e) {}
              return orig.apply(this, arguments);
            };
          }
          window.__sentBodies.length = 0;
          return true;
        })()`);

        await pushToL4();

        const bodies = await evaluate(`window.__sentBodies.filter(function(b){return /\\/api\\/report/.test(b.url);})`);
        const sent = Array.isArray(bodies.value) ? bodies.value : [];
        eq(sent.length, 1, '触发一次 L4 → 恰好发出 1 个上报请求（不是"每次都发一串"）');

        const rawBody = sent.length ? sent[0].body : '';
        console.log('  · 患者端实际发出的请求体：' + rawBody);

        const stored = relay.state.events[relay.state.events.length - 1] || {};
        console.log('  · 中继实际收到并落库的事件：' + JSON.stringify(stored));

        const namesRes = await evaluate(`Store.state.medicines.map(function(m){return m.name;})`);
        const names = Array.isArray(namesRes.value) ? namesRes.value : [];
        eq(names.length > 0, true, '（前提）药箱里确实有带真实药名的药品');
        eq((await evaluate(`Store.state.user.hideDrugName`)).value, false,
          '（前提）此用例跑在**默认配置**上：隐藏药名是关闭的');

        const leakedSent = names.filter((n) => rawBody.includes(n));
        eq(leakedSent, [],
          `**默认配置下**患者端发出的整段请求体不含任何药名（实际正文含："${String(stored.text)}"）`);

        const leakedStored = names.filter((n) => JSON.stringify(stored).includes(n));
        eq(leakedStored, [],
          '中继落库的那条事件（家属能看到的那些字段）同样不含任何药名');

        ok(!/\d+\s*(片|粒|袋|丸|毫升|ml|mg|毫克)/i.test(String(stored.text || '')),
          '事件正文里也不含任何剂量');

        // 反向断言：本机自己的提醒描述**照旧**带药名——修隐私不能顺手把正常功能阉掉。
        // 没有这一条，"事件不含药名"完全可以用"所有地方都不再显示药名"来作弊通过。
        const descRes = await evaluate(`(function(){
          var r = Store.state.reminders.filter(function (x) { return x.status === 'pending'; })[0];
          if (!r) return null;
          var d = ReminderEngine.describe(r);
          return { title: d.title, body: d.body };
        })()`);
        ok(descRes.value && names.some((n) => String(descRes.value.title).includes(n)),
          '反向断言：本机自己的通知标题**仍然显示药名**（默认不隐藏），隐私修复没有把正常提醒一起阉掉');
      }

      /* ---- 11c. 患者端那张卡片：它说的话有没有证据 ---- */
      // 「我的 → 家属协同」这张卡片上有三处是"界面在说话"，此前一条断言都没有：
      //   ① 右上角状态徽标（已连接 / 未配置）
      //   ② 显示给用户的邀请码
      //   ③ 「上次投递：已送达 N 位家属」
      // 第 ③ 处正是 P8-29 那句谎话所在的同一个位置——只是从 toast 挪到了卡片上。
      const meCard = async () => {
        await evaluate(`(function(){ App.go('me'); return true; })()`);
        await sleep(200);
        return String((await evaluate(`document.getElementById('screen').innerText`)).value || '');
      };

      let card = await meCard();
      has(card, '已连接', '配置成功后卡片如实显示"已连接"');
      has(card, relayBase, '卡片上显示的服务器地址就是实际连上的那一个');
      has(card, 'MEDI-E2E1', '卡片上显示的邀请码就是中继真正受理的那一个（不是本地自己编的）');
      has(card, '已送达 1 位家属', '「上次投递」与中继返回的真实结果一致');
      eq(card.indexOf('MEDI-8F3K'), -1, '页面上再也没有那个写死的假邀请码 MEDI-8F3K');

      /* ---- 11d. 隐私模式（本机显示层）：药名与剂量不出现在本机通知里 ---- */
      await evaluate(`(function(){ Store.updateUser({ hideDrugName: true }); return true; })()`);
      const alertsBefore = caregiverSeen.filter(e => e.event === 'alert').length;
      await pushToL4();
      const alertsNow = caregiverSeen.filter(e => e.event === 'alert');
      eq(alertsNow.length, alertsBefore + 1, '隐私模式下仍会通知家属（保护隐私 ≠ 不提醒）');
      {
        const d2 = JSON.parse(alertsNow[alertsNow.length - 1].data);
        ok(!/氨氯地平|二甲双胍|阿托伐他汀/.test(d2.text || ''),
          `隐私模式下事件里**没有药名**（实际正文："${(d2.text || '').slice(0, 30)}"）`);
        ok(!/\d+\s*片/.test(d2.text || ''), '隐私模式下事件里没有剂量');
      }

      /* ---- 11e. 家属全部离线时：卡片必须说"未送达" ---- */
      try { caregiverReq && caregiverReq.destroy(); } catch { }
      caregiverReq = null;
      await sleep(300);
      await pushToL4();
      card = await meCard();
      has(card, '未送达任何家属', '家属不在线时如实说"未送达任何家属"（不沉默，也不谎报已送达）');

      /* ---- 11f. 解绑后不再发送，卡片也不能还留着邀请码 ---- */
      await evaluate(`(function(){ Relay.unpair(); return true; })()`);
      const before = relay.state.events.length;
      await pushToL4();
      eq(relay.state.events.length, before, '断开配置后，事件数不再增长（断开是真的断开）');

      card = await meCard();
      has(card, '未配置', '断开后卡片如实回到"未配置"');
      has(card, '完全不联网', '卡片明确写出"不配置 = 完全不联网"这一承诺');
      eq(/邀请码：/.test(card), false, '未配置时不显示任何邀请码（不拿一个假码糊弄人）');
      eq(/已绑定/.test(card), false,
        '未配置时不出现"某位家属已绑定"的字样——演示数据不是真绑定，不能配一个绿色徽标冒充');

      await relay.close();
    }

    /* ========== 12. 家属端页面本身 ========== */
    section('【12. 家属端页面本身（此前从未在任何测试里打开过）】');
    // 「故意造成的浏览器报错」登记表。
    // 第 12c 步会故意用一个无效邀请码，让服务端返回 404 —— 那一次报错**是断言的一部分**：
    // 它证明请求真的发出去了、服务器真的拒绝了，而不是页面自己编了个"绑定失败"。
    // 所以这里把它登记下来，第 13 组按**精确字符串**扣除，并要求它确实存在。
    // 这不是"过滤掩盖"：登记与扣除都是显式的，少一条会失败（说明请求没发出去），
    // 多一条也会失败（说明还有别的报错）。
    const expectedBrowserErrors = [];
    // 为什么必须单独测这一组：
    //   第 11 组里的"家属端"其实是**本测试文件自己写的 Node SSE 客户端**。
    //   它能证明"中继会把事件送出去"，却证明不了 app/caregiver.html 这个
    //   **真正给家属看的页面**能渲染、能绑定、能把收到的事件显示出来。
    //   页面在、文档在、SW 缓存里也有它，但从来没有人在浏览器里打开过它——
    //   这与 P8-29「已通知 N 位家属」是同一类：承诺写下了，没人验证过。
    {
      // 刻意不启用 Web Push：正好用来验证"服务器未启用推送"会不会被如实显示
      const relay = createRelay({});
      const relayPort = await relay.listen(0);
      const relayBase = `http://127.0.0.1:${relayPort}`;
      const CG_ORIGIN = `http://127.0.0.1:${PORT}`;
      const CG_URL = CG_ORIGIN + '/caregiver.html';

      const post = async (p, body) => (await fetch(relayBase + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })).json();

      const pair = await post('/api/pair', { code: 'MEDI-CG01', patientToken: 'pt_cg', patientLabel: '李奶奶' });
      ok(pair.ok, '中继侧登记好邀请码 MEDI-CG01（患者名字：李奶奶）');

      const cgText = async () => String((await evaluate('document.body.innerText')).value || '');
      const cgTabs = async () => (await evaluate('document.querySelectorAll(\'.tab\').length')).value;
      const txt = async (sel) => String((await evaluate(
        `(function(){var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : '';})()`)).value || '');
      const setVal = async (sel, v) => (await evaluate(
        `(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.value=${JSON.stringify(v)}; return true;})()`)).value;

      /* ---- 12a. 首屏就是"家属端"，不是患者端 ---- */
      await goto(CG_URL);
      eq(await cgTabs(), 0, '打开的是家属端页面（患者端一定会渲染 4 个 .tab，这里一个都没有）');
      has(await cgText(), '家属端', '首屏是绑定视图（标题写着「家属端」）');
      r = await evaluate(`!!document.getElementById('fServer') && !!document.getElementById('fCode') && !!document.getElementById('btnBind')`);
      eq(r.value, true, '服务器地址 / 邀请码 / 绑定按钮三个控件都在');

      /* ---- 12b. 输入校验：说得出具体哪里不对 ---- */
      await setVal('#fServer', 'ftp://x');
      await setVal('#fCode', 'MEDI-CG01');
      ok(await clickSel('#btnBind'), '对「绑定」按钮发出真实鼠标点击');
      await sleep(250);
      has(await txt('#bindMsg'), 'http://', '地址协议不对时明确指出要以 http:// 或 https:// 开头');
      eq((await evaluate(`!!document.getElementById('fServer')`)).value, true, '校验失败后仍停在绑定视图（没有假装成功）');

      await setVal('#fServer', relayBase);
      await setVal('#fCode', 'ME');
      await clickSel('#btnBind');
      await sleep(250);
      has(await txt('#bindMsg'), '邀请码', '邀请码太短时说明是邀请码的问题，而不是沉默不动');

      /* ---- 12c. 邀请码无效：绝不假装绑定成功 ---- */
      const errsBefore = errors.length;
      await setVal('#fCode', 'MEDI-NOPE');
      await clickSel('#btnBind');
      await sleep(700);
      has(await txt('#bindMsg'), '绑定失败', '邀请码无效时如实说"绑定失败"');
      eq((await evaluate(`!!document.getElementById('btnUnbind')`)).value, false,
        '绑定失败后**没有**切到已绑定视图（界面不说谎）');
      const delta = errors.slice(errsBefore);
      eq(delta.length, 1, '这次故意无效的绑定只产生 1 条浏览器报错（就是那次 404）');
      ok(/\/api\/claim/.test(delta[0] || ''), '那条报错正是 /api/claim 的 404（不是别的什么东西坏了）');
      expectedBrowserErrors.push(delta[0]);

      /* ---- 12d. 真实绑定：患者名字来自中继，不来自家属的输入 ---- */
      await setVal('#fServer', relayBase);
      await setVal('#fCode', 'medi-cg01');   // 故意用小写：页面应自行规范化
      await clickSel('#btnBind');
      await sleep(1000);
      eq((await evaluate(`!!document.getElementById('btnUnbind')`)).value, true,
        '绑定成功后切到"已绑定"视图（小写邀请码也能绑上，页面自己做了规范化）');
      let t2 = await cgText();
      has(t2, '李奶奶', '页面上显示的患者名字来自中继返回，而不是家属自己填进去的');
      has(t2, '实时连接：已连接', 'SSE 长连接建立，且如实显示"已连接"');
      has(t2, '还没有收到提醒', '尚未收到事件时明确说"还没有收到"，不用空白冒充（空白也可以被读成"没问题"）');
      eq((await (await fetch(relayBase + '/api/health')).json()).caregivers, 1,
        '中继侧确实登记了这位家属（两端是真的连上了，不是各自以为连上了）');

      /* ---- 12e. 患者上报 → 页面上真的显示出来 ---- */
      const evText = '李奶奶 08:00 的用药提醒未确认';
      const rep = await post('/api/report', {
        patientToken: 'pt_cg',
        event: { type: 'missed', level: 4, text: evText, scheduledAt: new Date().toISOString() }
      });
      eq(rep.delivered, 1, '中继如实报告"送达 1 位在线家属"');
      await sleep(700);
      eq((await evaluate(`document.querySelectorAll('.cg-alert').length`)).value, 1,
        '**家属端页面上真的多出 1 条提醒**（不是只有服务端收到了）');
      eq((await txt('.cg-alert .m')).trim(), evText,
        '页面上显示的正文与患者端上报的一字不差（不加工、不编造）');

      /* ---- 12f. 隐私文案：保护隐私 ≠ 不提醒 ---- */
      const evText2 = '有一条用药提醒未确认';
      await post('/api/report', { patientToken: 'pt_cg', event: { type: 'missed', level: 4, text: evText2 } });
      await sleep(700);
      eq((await evaluate(`document.querySelectorAll('.cg-alert').length`)).value, 2, '两条提醒都在');
      eq((await txt('.cg-alert .m')).trim(), evText2, '最新一条排在最上面');
      const t3 = await cgText();
      eq(/氨氯地平|二甲双胍|阿托伐他汀/.test(t3), false,
        '家属端整页文本里没有任何药名（隐私是结构性保证，不靠自觉）');

      /* ---- 12g. 通道状态必须如实：没有真实订阅就不许说"已开启" ---- */
      try { await send('Browser.grantPermissions', { origin: CG_ORIGIN, permissions: ['notifications'] }); }
      catch (e) { /* 部分环境不支持，下面按实际权限分别断言 */ }
      ok(await clickSel('#btnEnablePush'), '点击「开启后台通知」');
      await sleep(1400);
      const probe = await evaluate(`(async function(){
        var perm = (window.Notification && Notification.permission) || 'none';
        var hasSub = false;
        try { var reg = await navigator.serviceWorker.ready; hasSub = !!(await reg.pushManager.getSubscription()); } catch (e) {}
        var line = (document.body.innerText || '').split('\\n').filter(function(x){ return x.indexOf('后台推送：') === 0; })[0] || '';
        return { perm: perm, hasSub: hasSub, line: line };
      })()`);
      const p = probe.value || {};
      has(p.line || '', '后台推送：', '页面始终列出一行"后台推送：…"的状态（通道可用与否不隐瞒）');
      eq(/已开启/.test(p.line || '') && !p.hasSub, false,
        '没有真实订阅时**绝不**显示"已开启"——这条就是"界面在说谎"的准入线');
      ok(/未申请|拒绝了|不支持|未启用|注册失败/.test(p.line || ''),
        `推送状态是如实的一种（实际："${p.line}"）`);
      if (p.perm === 'granted') {
        has(p.line || '', '未启用', '服务器未启用 Web Push 时如实说"未启用"（此时页面关掉就真的收不到）');
      }

      /* ---- 12h. 刷新后仍绑定：绑定是持久的 ---- */
      await send('Page.reload');
      await sleep(1600);
      const t4 = await cgText();
      has(t4, '李奶奶', '刷新后仍是已绑定状态（绑定不会一刷新就丢）');
      has(t4, evText2, '刷新后仍能看到之前收到的提醒（本地留存，不是只活在内存里）');

      /* ---- 12i. 解绑：本地与中继两侧都要真的断 ---- */
      ok(await clickSel('#btnUnbind'), '点击「解绑」');
      await sleep(800);
      eq((await evaluate(`!!document.getElementById('fServer')`)).value, true, '解绑后回到绑定视图');
      eq((await (await fetch(relayBase + '/api/health')).json()).caregivers, 0,
        '解绑在中继侧也生效（不是只清了本地缓存）');

      /* ---- 12j. 断网打开 caregiver.html：SW 必须还回"家属端"这一页 ---- */
      // SW 的 fetch 处理器在离线时有一句回退 `caches.match('./index.html')`。
      // 如果 caregiver.html 没被缓存，家属断网打开自己的页面会拿到**患者端应用**——
      // 地址栏写着家属端、内容却是别人的用药清单。这就是"页面在说谎"的一种。
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await goto(CG_URL, 1600);
      eq(await cgTabs(), 0, '断网打开 caregiver.html 时得到的仍是家属端（没有被 SW 回退成患者端）');
      has(await cgText(), '家属端', '断网时家属端页面仍可用（SW 缓存的是它自己这一页）');
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

      await relay.close();
    }

    section('【13. 运行期错误】');
    // 先扣除「故意造成的报错」（第 12c 步登记的无效邀请码 404）。
    // 扣除前先核对登记表非空——否则"扣除"就变成了一句空转，
    // 哪天那条请求不再发出，这里也会悄悄放过。
    eq(expectedBrowserErrors.length, 1, '上一组登记的"故意 404"确实发生过（登记表不是空的）');
    const remaining = errors.slice();
    for (const e of expectedBrowserErrors) {
      const i = remaining.indexOf(e);
      if (i >= 0) remaining.splice(i, 1);
    }
    const realErrors = remaining.filter(e => !/favicon|Service Worker|sw\.js/i.test(e));
    eq(realErrors.length, 0, '全流程无未捕获 JS 异常' + (realErrors.length ? '\n      ' + realErrors.join('\n      ') : ''));

  } finally {
    try { ws && ws.close(); } catch { }
    proc.kill();
    await sleep(400);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
  console.log(`截图目录：${SHOT_DIR}`);
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('检查脚本异常：', e); process.exit(2); });
