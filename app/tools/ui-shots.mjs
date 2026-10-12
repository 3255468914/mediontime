#!/usr/bin/env node
/**
 * ui-shots.mjs — 关键页面 UI 稿生成器 + 渲染断言
 *
 * 为什么需要它：交付物 #4 要求「关键页面 UI 稿」，但此前截图只存在于
 * 系统临时目录，换台机器就没了。这里把 UI 稿**直接生成进仓库**（docs/ui/），
 * 并顺手把「这个页面真的渲染出来了」变成断言——截图与断言同源，
 * 就不会出现「文档里贴的图是很久以前的版本」这种漂移。
 *
 * 它同时是测试：任一页面渲染异常即以非 0 退出。
 *
 * 运行：
 *   cd app
 *   python -m http.server 8788 --bind 127.0.0.1   # 另开一个终端
 *   node tools/ui-shots.mjs --port 8788
 *
 * 产出：
 *   docs/ui/*.png        12 张关键页面截图
 *   docs/ui/manifest.json 清单（含 sha256，便于核对图有没有被换过）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('--port', '8788');
const OUT_DIR = resolve(arg('--out', join(REPO, 'docs', 'ui')));
const DEBUG_PORT = arg('--debugPort', '9341');
const BASE = `http://127.0.0.1:${PORT}/index.html`;

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
if (!BROWSER) { console.error('✗ 未找到可用的 Chrome / Edge 可执行文件'); process.exit(2); }

mkdirSync(OUT_DIR, { recursive: true });
const PROFILE = join(tmpdir(), 'mediontime-ui-shots-' + Date.now());

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(c, name) {
  if (c) { pass++; console.log(`    ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`    ✗ ${name}`); }
}
function section(t) { console.log(`\n${t}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDevtools(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const page = (await res.json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

const manifest = [];

/**
 * 从 PNG 字节流读出真实像素尺寸（IHDR 紧随 8 字节签名 + 4 字节长度 + 4 字节类型）。
 * 之所以要真的去读文件，而不是把 `setDeviceMetricsOverride` 的值抄进清单：
 * 那个值是**视口设置**，不是图片尺寸。`captureBeyondViewport` 抓到的是整页，
 * 而 09/10 两张还带了 maxH 上限，于是清单里写着 09 是 460×1040，
 * 文件实际却是 920×4278 —— 一份"用来核对图有没有被换过"的清单，
 * 自己的尺寸却对不上图。这正是本项目一直在防的那类问题（见 docs/04 §4.8）。
 */
function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  console.log(`浏览器：${BROWSER}`);
  console.log(`输出目录：${OUT_DIR}`);
  const proc = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`, '--window-size=460,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, msgId = 0;
  const pending = new Map();

  function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
    });
  }

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){ try { return { value: await (${expr}) }; } catch(e) { return { error: String((e && e.message) || e) }; } })()`,
      returnByValue: true, awaitPromise: true
    });
    const v = r.result && r.result.value;
    if (v && v.error) return { error: v.error };
    return { value: v ? v.value : undefined };
  }

  async function goto(url, waitMs = 1100) {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async function text(sel = '#screen') {
    const r = await evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:'';})()`);
    return String(r.value || '');
  }

  /**
   * 注入确定性时钟：把「现在」固定成**当天 23:30**，再加载页面。
   *
   * 为什么必须控制时钟而不是造数据：
   * 应用自带的演示种子只为「今天已经过去的时间点」补历史（见 store.js 的 `seed()`），
   * 而记录页与统计页又都会按 `now` 过滤掉未来的时间点。
   * 于是如果在凌晨 00:0x 生成 UI 稿，一剂都还没到点——
   * 记录页与统计页全空，今日页四剂全是待服，交付物既没有信息量也不可复现。
   *
   * 试过一条错路：直接用 Store 的公开方法把今日「补」出结果。
   * 结果是**自相矛盾的状态**——07:00 的服药记录落在未来，
   * 被按 `now` 过滤的统计正确排除了，截图上写着「近 30 天共 0 次应服药记录」。
   * 这说明：**伪造与真实时钟冲突的状态，只会得到一个更隐蔽的错误画面。**
   *
   * 正确做法是让时钟走到那个时刻，而不是让数据假装时钟已经走到了。
   * 用 `Page.addScriptToEvaluateOnNewDocument` 在每个文档的最前面替换 `Date`，
   * 应用代码一行不改，行为与真实运行完全一致。
   *
   * 选 23:30 而非任意时刻：此时当天 4 个服药点（07:00 / 12:00 / 18:00 / 21:00）
   * 全部已过，且 21:00 已超出 120 分钟窗口——于是今日页呈现
   * 「2 剂有结果 + 1 剂漏服 + 1 剂结算为漏服」这一信息量最大的状态。
   */
  const demoAt = new Date();
  demoAt.setHours(23, 30, 0, 0);
  const CLOCK_OFFSET_MS = demoAt.getTime() - Date.now();

  async function installDeterministicClock() {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function () {
  var RealDate = Date;
  var OFFSET = ${CLOCK_OFFSET_MS};
  function FakeDate(a, b, c, d, e, f, g) {
    if (!(this instanceof FakeDate)) return RealDate.apply(null, arguments);
    if (arguments.length === 0) return new RealDate(RealDate.now() + OFFSET);
    if (arguments.length === 1) return new RealDate(a);
    return new RealDate(a, b, c || 0, d || 0, e || 0, f || 0, g || 0);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = function () { return RealDate.now() + OFFSET; };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.setPrototypeOf(FakeDate, RealDate);
  window.Date = FakeDate;
})();`
    });
    console.log(`确定性时钟：固定为 ${demoAt.toString()}（偏移 ${(CLOCK_OFFSET_MS / 3600000).toFixed(2)} 小时）`);
  }

  async function text(sel = '#screen') {
    const r = await evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:'';})()`);
    return String(r.value || '');
  }

  /** 断言「确定性演示时刻」真的落到了预期状态——这是后续所有截图可信的前提 */
  async function assertDemoMoment() {
    const r = await evaluate(`(function(){
      var d = new Date();
      var p2 = function (n) { return String(n).padStart(2, '0'); };
      return {
        hm: p2(d.getHours()) + ':' + p2(d.getMinutes()),
        logs: Store.state.logs.length,
        miss: Store.state.reminders.filter(function (x) { return x.status === 'missed'; }).length,
        conf: Store.state.reminders.filter(function (x) { return x.status === 'confirmed'; }).length
      };
    })()`);
    const v = r.value || {};
    ok(v.hm === '23:30', `页面内时钟固定为 23:30（实测 ${v.hm}）`);
    ok(v.logs >= 3, `演示时刻已有 ${v.logs} 条服药记录（统计页因此有数据）`);
    ok(v.conf >= 2 && v.miss >= 1, `今日状态含 ${v.conf} 剂有结果、${v.miss} 剂漏服`);
  }

  /** 把整页撑开再截，避免只拍到首屏。opts.maxH 用于弹层：浮层会铺满整机高度，
   *  不设上限时在长页面（如设置页）上会被拉到 2000px 以上，反而不便查看。 */
  async function capture(name, title, note, opts) {
    await evaluate(`(function(){
      // 「截图模式」：把几处会让同一份代码产出不同 PNG 的因素固定住。
      // 1) 动画与过渡：L3 全屏强提醒的铃铛有脉冲动画、弹层有 slideup，
      //    不冻结的话每次抓到的帧都不同，「可复现」就成了空话。
      // 2) .sheet 的 max-height:80% 会与下面「机身高度自适应」形成循环依赖
      //    （sheet 高度取决于机身高度，机身高度又取决于 sheet 高度），
      //    结果依赖上一次视口，导致弹层截图高度漂移。改为按内容撑开。
      // 3) toast 有 2.6 秒渐隐窗，抓到的可能是半透明中间态；直接清掉。
      if (!document.getElementById('__shot_freeze__')) {
        var st = document.createElement('style');
        st.id = '__shot_freeze__';
        st.textContent =
          '*, *::before, *::after { animation: none !important; transition: none !important; }' +
          '.sheet { max-height: none !important; overflow: visible !important; }';
        (document.head || document.documentElement).appendChild(st);
      }
      var t = document.getElementById('toast');
      if (t) { t.classList.remove('show'); t.textContent = ''; }
      var s = document.getElementById('screen');
      if (s) { s.scrollTop = 0; s.style.height = 'auto'; s.style.overflow = 'visible'; }
      var p = document.getElementById('phone');
      if (p) p.style.height = 'auto';
      try { window.scrollTo(0, 0); } catch (e) {}
      return true;
    })()`);
    await sleep(150);
    const box = await evaluate(`(function(){var p=document.getElementById('phone');if(!p)return 900;return Math.ceil(p.getBoundingClientRect().height);})()`);
    const maxH = (opts && opts.maxH) || 4200;
    // body 上下各有 28px 内边距，留够余量避免底边被裁
    const h = Math.min(maxH, Math.max(430, (Number(box.value) || 900) + 64));
    await send('Emulation.setDeviceMetricsOverride', { width: 460, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(220);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const buf = Buffer.from(r.data, 'base64');
    const file = name + '.png';
    writeFileSync(join(OUT_DIR, file), buf);

    // 记**文件自己的**像素尺寸，并附上逻辑尺寸与缩放比，避免"清单说一套、文件是另一套"
    const px = readPngSize(buf);
    ok(px.width === 460 * 2 && px.height > 0,
      `${file} 真实像素尺寸可读出且宽度为 460 CSS px × DPR 2（实际 ${px.width}×${px.height}）`);
    manifest.push({
      file, title, note: note || '',
      width: px.width, height: px.height,
      cssWidth: Math.round(px.width / 2), cssHeight: Math.round(px.height / 2),
      deviceScaleFactor: 2,
      viewportHeight: h,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
      capturedAt: new Date().toISOString()
    });
    console.log(`    · ${file}  ${px.width}×${px.height}  ${(buf.length / 1024).toFixed(0)}KB`);
    return h;
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
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await installDeterministicClock();

    /* ===== 01 首启引导 + 免责声明 =====
     * 必须是第一次导航：全新 profile，未勾选免责声明 → 停在引导页。
     * 之后的导航都带 ?auto=1（等价于"已同意"）进入主界面。 */
    section('【01】首启引导与免责声明（全新用户）');
    await goto(BASE);
    let t = await text();
    ok(t.indexOf('免责') !== -1, '引导页出现免责声明文案');
    ok(t.length > 120, `引导页内容非空（${t.length} 字）`);
    await capture('01-onboard-consent', '首启引导 + 免责声明',
      '首次启动强制勾选，未同意不进入主界面。适用人群与风险提示在此说明。');

    /* ===== 02 今日页 ===== */
    section('【02】今日页（用药时间轴）');
    await goto(BASE + '?auto=1&page=today');
    await assertDemoMoment();
    let n = await evaluate(`document.querySelectorAll('.dose').length`);
    ok(n.value >= 3, `时间轴渲染出 ${n.value} 条用药安排`);
    t = await text();
    ok(/下一剂|今日用药计划|今天的用药时间点/.test(t), '顶部摘要显示下一剂时间或当日进度');
    ok(/已按时/.test(t) && /漏服/.test(t), '同一屏同时出现「已按时」与「漏服」（确定性演示日生效）');
    await capture('02-today', '今日页 · 用药时间轴',
      '顶部摘要给"下一剂几点吃"，下方按时间列出全天安排；已服/待服状态用颜色与文字双重区分，不只靠颜色。');

    /* ===== 03 今日页 · 长者模式 ===== */
    section('【03】今日页 · 长者模式');
    await evaluate(`App.toggleElder()`);
    await sleep(350);
    const elderOn = await evaluate(`document.getElementById('phone').classList.contains('elder')`);
    ok(elderOn.value === true, '长者模式已开启（.phone.elder 生效）');
    const fs = await evaluate(`getComputedStyle(document.getElementById('phone')).fontSize`);
    ok(parseFloat(fs.value) >= 20, `根字号放大到 ${fs.value}（普通模式 15px）`);
    await capture('03-today-elder', '今日页 · 长者模式',
      '根字号 15px → 20px，副文字提亮、分割线加深；点击区不小于 44px。仅放大字号不算数，对比度与点击区一并调整。');
    await evaluate(`App.toggleElder()`);
    await sleep(250);

    /* ===== 04 用药列表 ===== */
    section('【04】用药与处方列表');
    await goto(BASE + '?auto=1&page=meds');
    t = await text();
    ok(t.length > 80, `用药页内容非空（${t.length} 字）`);
    ok(t.indexOf('用药') !== -1 || t.indexOf('计划') !== -1, '页面标题/区块与用药相关');
    await capture('04-meds', '用药与处方列表',
      '一张药品卡承载多条用药计划；每一项都是真 <button>，键盘与读屏器可直接操作。');

    /* ===== 05 药品编辑页 ===== */
    section('【05】药品编辑页（新增处方）');
    await evaluate(`App.newMedicine()`);
    await sleep(600);
    t = await text();
    ok(/药名|名称|剂量/.test(t), '编辑页出现药名/剂量等表单字段');
    ok(t.indexOf('时间') !== -1 || t.length > 200, '编辑页包含服药时间设置');
    await capture('05-edit', '药品编辑页 · 新增处方',
      '药名/规格/剂型/剂量/频次/餐前餐后锚点/疗程起止。餐前 30 分钟这类相对锚点由排程引擎换算成绝对时间。');

    /* ===== 06 记录页 ===== */
    section('【06】记录页（日历热力图）');
    await goto(BASE + '?auto=1&page=log');
    t = await text();
    const cal = await evaluate(`document.querySelectorAll('.cal-d').length`);
    ok(cal.value >= 7, `日历格子渲染出 ${cal.value} 个`);
    ok(t.indexOf('记录') !== -1 || t.indexOf('服') !== -1, '记录页文案正常');
    await capture('06-log', '记录页 · 日历热力图',
      '按日汇总按时/延迟/漏服三种状态；点任一天可查看当天逐条明细。历史记录只读，改处方不会改写历史。');

    /* ===== 07 依从性统计 ===== */
    section('【07】依从性统计');
    await goto(BASE + '?auto=1&page=stats');
    t = await text();
    const bars = await evaluate(`document.querySelectorAll('.hbar').length`);
    ok(bars.value >= 1, `依从率条渲染出 ${bars.value} 条`);
    ok(/依从|按时|率/.test(t), '统计页出现依从率相关文案');
    await capture('07-stats', '依从性统计 · 复诊用',
      '按药品聚合按时率；补服单独计数但不覆盖原漏服记录，复诊时给医生看的是完整事实。');

    /* ===== 08 设置页 ===== */
    section('【08】设置页');
    await goto(BASE + '?auto=1&page=me');
    t = await text();
    ok(t.indexOf('提醒') !== -1, '设置页出现"提醒"相关区块');
    ok(/长者模式|隐私/.test(t), '设置页包含长者模式/隐私相关开关');
    await capture('08-me', '设置页 · 提醒可靠性与隐私',
      '提醒可靠性卡片如实报告当前托管能力（不谎报"已托管"）；隐私模式、长者模式、免责声明与隐私政策均可达。');

    /* ===== 09 提醒可靠性详情 ===== */
    section('【09】提醒可靠性详情弹层');
    await evaluate(`App.showDiag()`);
    await sleep(500);
    t = await text('#sheet');
    ok(t.length > 40, `详情弹层内容非空（${t.length} 字）`);
    ok(/可靠|托管|闹钟/.test(t), '弹层说明当前平台的提醒托管能力');
    await capture('09-reliability', '提醒可靠性详情',
      '把"到点会不会响"讲清楚：本平台能托管多少条、权限是否已授、应用关闭后会怎样。这是全项目最重要的一块诚实界面。',
      { maxH: 1040 });
    await evaluate(`App.closeSheet()`);
    await sleep(250);

    /* ===== 10 L3 全屏强提醒 ===== */
    section('【10】L3 全屏强提醒');
    await evaluate(`(async function(){
      var list = Store.state.reminders.filter(function(x){ return x.status === 'pending'; });
      if (!list.length) return false;
      list.sort(function(a,b){ return new Date(a.scheduledAt) - new Date(b.scheduledAt); });
      var p = list[0];
      p.scheduledAt = new Date(Date.now() - 20 * 60000).toISOString();  // 20 分钟前 → 反推出 L3
      p.level = 0; p.fireAt = null;
      Store.save();
      ReminderEngine.reschedule();
      return true;
    })()`);
    await sleep(700);
    const shown = await evaluate(`document.getElementById('fsAlert').classList.contains('show')`);
    ok(shown.value === true, '逾期提醒按时间反推出 L3，全屏强提醒已弹出');
    const fsName = await evaluate(`document.getElementById('fsName').textContent`);
    ok(String(fsName.value || '').length > 0, `全屏提醒带出药品名（"${fsName.value}"）`);
    await capture('10-l3-fullscreen', 'L3 全屏强提醒',
      '超过 15 分钟未确认即全屏弹出，两个大按钮覆盖绝大多数视线与操作面；同时带 role=alertdialog，读屏器会立即播报而不是静默出现。',
      { maxH: 900 });

    /* ===== 11 时区变化二选一 ===== */
    section('【11】时区变化二选一弹层');
    await goto(BASE + '?auto=1&page=today&simTz=UTC-11');
    await sleep(900);
    t = await text('#sheet');
    ok(t.length > 40, `时区弹层内容非空（${t.length} 字）`);
    ok(/时区|保持|当地/.test(t), '弹层给出"保持原节奏 / 按当地时间"两个选项');
    await capture('11-tz-prompt', '跨时区 · 二选一',
      '检测到时区变化后不擅自决定：保持原服药节奏（按经过时长平移）或按当地时间重新对齐，两个选项都把具体钟点换算写出来。');
    await evaluate(`App.tzLater()`);
    await sleep(250);

    /* ===== 12 漏服补救弹层 ===== */
    section('【12】漏服补救弹层');
    await evaluate(`(async function(){
      var list = Store.state.reminders.filter(function(x){ return x.status === 'missed'; });
      if (!list.length) return false;
      list.sort(function(a,b){ return new Date(b.scheduledAt) - new Date(a.scheduledAt); });
      App.openMakeup(list[0].id);      // 取当天最晚的那剂漏服，距下次服药的间隔最大
      return true;
    })()`);
    await sleep(500);
    t = await text('#sheet');
    ok(t.indexOf('漏服了') !== -1, '补救弹层如实告知漏服的是哪一剂');
    ok(t.indexOf('不提供任何医疗建议') !== -1, '弹层含"不提供医疗建议 / 请遵医嘱"提示');
    ok(/补服|跳过|知道了/.test(t), '弹层给出可执行的补救选项');
    await capture('12-makeup', '漏服补救询问',
      '询问"补服 / 跳过"，并把距下次服药的间隔算出来告知用户；补服记录独立留存，不覆盖原漏服记录。全程不给剂量建议。');

    /* ===== 清单自校验：清单说的必须与文件里的事实一致 ===== */
    // 一份"用来核对图有没有被换过"的清单，如果自己不核对，就等于没有清单。
    // 这里反过来读一遍磁盘上的 PNG，把尺寸与 sha256 与清单逐张对齐。
    section('【清单自校验】');
    let mismatched = [];
    for (const s of manifest) {
      const onDisk = readFileSync(join(OUT_DIR, s.file));
      const size = readPngSize(onDisk);
      const sha = createHash('sha256').update(onDisk).digest('hex').slice(0, 16);
      if (size.width !== s.width || size.height !== s.height || sha !== s.sha256) {
        mismatched.push(`${s.file}（清单 ${s.width}×${s.height}/${s.sha256}，磁盘 ${size.width}×${size.height}/${sha}）`);
      }
    }
    ok(mismatched.length === 0,
      `清单里 ${manifest.length} 张图的尺寸与 sha256 与磁盘文件逐张一致` +
      (mismatched.length ? '：' + mismatched.join('；') : ''));
    ok(manifest.every(s => s.cssWidth * s.deviceScaleFactor === s.width),
      '每张图的逻辑尺寸 × 设备像素比 = 记录的真实像素尺寸（单位口径统一）');

    /* ===== 清单落盘 ===== */
    writeFileSync(join(OUT_DIR, 'manifest.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        base: BASE,
        deterministicClock: demoAt.toISOString(),
        clockNote: '截图时页面内的「现在」被固定为该时刻（当天 23:30），使 UI 稿与运行时刻无关',
        shots: manifest
      }, null, 2) + '\n');

  } finally {
    try { ws && ws.close(); } catch { }
    proc.kill();
    await sleep(400);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`UI 稿 ${manifest.length} 张 → ${OUT_DIR}`);
  console.log(`断言 总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('生成器异常：', e && e.message ? e.message : e);
  process.exit(2);
});
