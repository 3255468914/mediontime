#!/usr/bin/env node
/**
 * a11y-tree.mjs — 无障碍树（真实浏览器里的 AX Tree）检查
 *
 * 为什么还需要它：a11y.test.cjs 是**源码静态分析**——它检查 CSS 里写了多高的对比度、
 * HTML 里写了哪些 aria-*。但"源码里写了 aria-label"和"辅助技术真的收到了这个名字"
 * 是两件事。中间隔着一层浏览器：ARIA 属性算不算数、算成什么名字、节点到底有没有
 * 进入可访问性树，全部由浏览器决定，源码里看不出来。典型反例：
 *   · aria-labelledby 指向一个不存在的 id  → 名字为空，源码上却"明明写了"
 *   · role="switch" 写在 div 上但节点被算法吞掉 → 读屏器只念"div"
 *   · aria-hidden="true" 的子树里留着可聚焦元素 → 键盘能 Tab 进一个读屏器不念的地方
 * 这些都不是崩溃、不是报错，是**界面在撒谎**的第四种形态：
 * 源码里写得很好看，真实暴露给辅助技术的东西却是另一回事。
 *
 * 所以本套件不读源码，只读事实：
 *   Accessibility.getFullAXTree()  拿浏览器算出来的树
 *   Input.dispatchKeyEvent         发真实的 Tab / Enter / Esc
 *   Input.dispatchMouseEvent       发真实的鼠标点击（程序化 click() 不聚焦，会出假阳性）
 *
 * 运行：
 *   cd app
 *   python -m http.server 8788 --bind 127.0.0.1   # 另开一个终端
 *   node tests/a11y-tree.mjs --port 8788
 *
 * 它**不能**替代真人读屏测试（docs/03 §四 的 A-01~A-06 仍需人工做）：
 * 它证明的是"树里的名字与角色是对的"，证不了"VoiceOver 念得好不好听"、
 * "焦点环老花眼看不清"、"真实老人能不能自己走完"。边界写清楚，别越界宣称。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('--port', '8788');
const DEBUG_PORT = arg('--debugPort', '9353');
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
const PROFILE = join(tmpdir(), 'mediontime-a11y-tree-' + Date.now());

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function ok(c, name) { eq(!!c, true, name); }
function atMost(actual, max, name) {
  if (actual <= max) { pass++; console.log(`  ✓ ${name}（${actual} ≤ ${max}）`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      要求 ≤ ${max}，实际 ${actual}`); }
}
function atLeast(actual, min, name) {
  if (actual >= min) { pass++; console.log(`  ✓ ${name}（${actual} ≥ ${min}）`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      要求 ≥ ${min}，实际 ${actual}`); }
}
function section(t) { console.log(`\n${t}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 术语 ---------- */
// 浏览器把可聚焦控件都算成这些角色之一
const INTERACTIVE = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'textbox',
  'combobox', 'listbox', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'slider', 'spinbutton', 'searchbox', 'DisclosureTriangle', 'option']);
// 这些"名字"等于没说。读屏器念完等于没念，且无法区分两个不同按钮。
const GENERIC_NAMES = ['', '按钮', '链接', '对话框', '开关', '下拉框', '组合框',
  'button', 'link', 'dialog', 'switch', 'div', '点击', '点这里'];

async function waitForDevtools(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
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
  const jsErrors = [];

  function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
    });
  }

  async function evaluate(expr) {
    // 用 async 包一层并 await：同步表达式与返回 Promise 的表达式都能取回
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){ try { return { value: await (${expr}) }; } catch(e) { return { error: String((e && e.message) || e) }; } })()`,
      returnByValue: true, awaitPromise: true
    });
    // evaluate 会把表达式包进 await (...)，所以多语句必须用 IIFE 包起来
    const v = r.result && r.result.value;
    if (v && v.error) return { error: v.error };
    return { value: v ? v.value : undefined };
  }

  /* ---------- 确定性时钟 ----------
   * 同 ui-shots.mjs 的理由：今日页内容随"当前几点"变化，
   * 直接断言会变成"某个时刻才会炸"的定时炸弹。
   * 这里固定为**当天 06:00**——当天 4 个服药点全部还没到，
   * 于是今日页有 4 个功能相同、文案相同的"我已服药"按钮，
   * 正好用来验证"界面上看着一样的东西，读屏器能不能分清"。
   */
  const demoAt = new Date();
  demoAt.setHours(6, 0, 0, 0);
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
  }

  /* ---------- 取事实的小工具 ---------- */

  /** 浏览器算出来的完整可访问性树，只保留没被忽略的节点 */
  async function axTree() {
    const t = await send('Accessibility.getFullAXTree');
    return (t.nodes || []).filter(n => !n.ignored);
  }
  const roleOf = n => (n.role && n.role.value) || '';
  const nameOf = n => String((n.name && n.name.value) || '');
  const propOf = (n, k) => {
    const p = (n.properties || []).find(x => x.name === k);
    if (!p) return undefined;
    const v = p.value && p.value.value;
    // CDP 里 tristate 属性（checked）给的是字符串 'true'/'false'/'mixed'，
    // 而 boolean 属性（modal）给的是真布尔。不统一就会出现
    // "false" !== false 这种假失败——又是"以为的接口"和"真的接口"不一致。
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  };

  /** 把 DOM 选择器命中的元素，逐个换成浏览器算出来的 AX 名称与角色。
   *  为什么要绕 DOM：AX 树里没有选择器，只有 backendNodeId；
   *  而"某个按钮的名字是什么"必须按元素问，不能靠源码里的字符串猜。 */
  async function axOf(selector) {
    const doc = await send('DOM.getDocument', { depth: 1 });
    const q = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
    const out = [];
    for (const nodeId of (q.nodeIds || [])) {
      const d = await send('DOM.describeNode', { nodeId, depth: 0 });
      const back = d.node && d.node.backendNodeId;
      let name = '', role = '', ignored = true;
      if (back) {
        const ax = await send('Accessibility.getPartialAXTree', { backendNodeId: back, fetchRelatives: false });
        const n = (ax.nodes || [])[0] || {};
        ignored = !!n.ignored;
        if (!ignored) { name = nameOf(n); role = roleOf(n); }
      }
      out.push({ name, role, ignored });
    }
    return out;
  }

  /** 当前焦点元素的描述（用于断言"焦点到底去哪了"） */
  async function activeEl() {
    const r = await evaluate(`(function(){
      var a = document.activeElement;
      if (!a) return null;
      return {
        tag: a.tagName,
        id: a.id || '',
        cls: String(a.className || '').slice(0, 40),
        aria: a.getAttribute ? (a.getAttribute('aria-label') || '') : '',
        text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
        inSheet: !!(a.closest && a.closest('#sheet')),
        inOverlay: !!(a.closest && a.closest('#overlay')),
        inFsAlert: !!(a.closest && a.closest('#fsAlert'))
      };
    })()`);
    return r.value;
  }

  /** 元素在不在可访问性树里（按选择器问第一个命中项） */
  async function axNodeOf(selector) {
    const doc = await send('DOM.getDocument', { depth: 1 });
    const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) return { missing: true };
    const d = await send('DOM.describeNode', { nodeId: q.nodeId, depth: 0 });
    const back = d.node && d.node.backendNodeId;
    if (!back) return { missing: true };
    const ax = await send('Accessibility.getPartialAXTree', { backendNodeId: back, fetchRelatives: false });
    const n = (ax.nodes || [])[0] || {};
    return {
      ignored: !!n.ignored, role: roleOf(n), name: nameOf(n),
      description: String((n.description && n.description.value) || ''),
      modal: propOf(n, 'modal'), checked: propOf(n, 'checked')
    };
  }

  async function goto(url, waitMs = 1500) {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async function key(k, code, vk) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(70);
  }
  const pressTab = () => key('Tab', 'Tab', 9);
  const pressEsc = () => key('Escape', 'Escape', 27);

  /** 真实鼠标点击（按选择器定位）：程序化 click() 不聚焦，
   *  用它验证"焦点归还是否生效"会得到假阳性——这里必须是真事件。 */
  async function mouseClick(selector, nth = 0) {
    const r = await evaluate(`(function(){
      var es = document.querySelectorAll(${JSON.stringify(selector)});
      var e = es[${nth}];
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      var rc = e.getBoundingClientRect();
      return { x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2) };
    })()`);
    if (!r.value) return false;
    const { x, y } = r.value;
    await sleep(220);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(420);
    return true;
  }

  /** 把焦点退回文档起点，保证 Tab 序列从头开始 */
  async function resetFocus() {
    await evaluate(`(function(){ try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch(e){} window.scrollTo(0,0); return true; })()`);
    await sleep(120);
  }

  const PAGES = [
    { q: '?auto=1&page=today', label: '今日页' },
    { q: '?auto=1&page=meds', label: '用药页' },
    { q: '?auto=1&page=log', label: '记录页' },
    { q: '?auto=1&page=stats', label: '统计页' },
    { q: '?auto=1&page=me', label: '设置页' }
  ];

  try {
    const target = await waitForDevtools();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        jsErrors.push('未捕获异常：' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        jsErrors.push('console.error：' + m.params.args.map(a => a.value ?? a.description).join(' '));
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    await send('Accessibility.enable');
    // 无头页面默认"失焦"，键盘事件不会产生焦点移动。打开焦点模拟才是真条件。
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 900, deviceScaleFactor: 1, mobile: true });
    await installDeterministicClock();
    console.log(`确定性时钟：固定为 ${demoAt.toString()}`);

    /* ============================================================
     * 1. 每个可交互控件都必须有「能被区分开」的名称
     * ============================================================ */
    section('【1】可访问名称完备性（五页面逐页）');
    const allNames = [];
    for (const p of PAGES) {
      await goto(BASE + p.q);
      const nodes = await axTree();
      const interactive = nodes.filter(n => INTERACTIVE.has(roleOf(n)));
      atLeast(interactive.length, 4, `${p.label}：可访问性树里有 ${interactive.length} 个可交互节点`);

      const unnamed = interactive.filter(n => nameOf(n).trim() === '');
      eq(unnamed.map(n => roleOf(n)), [], `${p.label}：没有"没有名字"的可交互控件`);

      const generic = interactive.filter(n => GENERIC_NAMES.indexOf(nameOf(n).trim()) !== -1);
      eq(generic.map(n => roleOf(n) + ':' + nameOf(n)), [], `${p.label}：没有名字等于没说的控件（"按钮"/"div"/空）`);

      const placeholders = interactive.filter(n => /undefined|null|NaN|\[object/.test(nameOf(n)));
      eq(placeholders.map(n => nameOf(n)), [], `${p.label}：名称里没有拼接失败的残留（undefined/null）`);

      allNames.push(...interactive.map(n => ({ page: p.label, role: roleOf(n), name: nameOf(n) })));
    }

    /* ============================================================
     * 2. 看得一样、念出来也要能分清
     * ============================================================ */
    section('【2】同名控件必须能区分（四个剂次的"我已服药"）');
    await goto(BASE + '?auto=1&page=today');
    const doseBtns = await axOf('.dose-cta button');
    const counts = await evaluate(`(function(){
      var rows = [].slice.call(document.querySelectorAll('.dose'));
      return rows.map(function(r){
        var t = r.querySelector('.dose-time');
        return t ? t.textContent.trim() : '';
      });
    })()`);
    atLeast(doseBtns.length, 3, `今日页有 ${doseBtns.length} 个剂次操作按钮（确定性时钟在 06:00）`);
    eq(doseBtns.filter(b => b.name.trim() === '').length, 0, '每个剂次按钮都有名称');
    const uniq = new Set(doseBtns.map(b => b.name.trim()));
    eq(uniq.size, doseBtns.length,
      `剂次按钮名称两两不同（${Array.from(uniq).join(' | ')}）`);
    const times = (counts.value || []).filter(Boolean);
    const allHaveTime = doseBtns.every(b => times.some(t => b.name.indexOf(t) !== -1));
    ok(allHaveTime, '每个剂次按钮的名称里都带上了该剂次的时间点（读屏器能分清在给哪一剂打卡）');

    /* ============================================================
     * 3. 下拉框必须有名称
     * ============================================================ */
    section('【3】下拉框（select）必须有可访问名称');
    await goto(BASE + '?auto=1&page=me');
    const sels = await axOf('#screen select');
    atLeast(sels.length, 2, `设置页有 ${sels.length} 个下拉框`);
    const selNames = sels.map(s => s.name.trim());
    eq(selNames.filter(n => n === ''), [], `每个下拉框都有名称（${selNames.join(' | ')}）`);
    ok(selNames.some(n => n.indexOf('窗口') !== -1 || n.indexOf('漏服') !== -1), '其中包含"漏服判定窗口"');
    ok(selNames.some(n => n.indexOf('间隔') !== -1 || n.indexOf('补服') !== -1), '其中包含"补服安全间隔"');

    /* ============================================================
     * 4. 开关：状态必须被真实暴露（docs/03 A-02 的可计算部分）
     * ============================================================ */
    section('【4】开关状态暴露（role=switch + aria-checked 真实生效）');
    const switchNodes = (await axTree()).filter(n => roleOf(n) === 'switch');
    atLeast(switchNodes.length, 6, `可访问性树里有 ${switchNodes.length} 个 switch 节点`);
    eq(switchNodes.filter(n => nameOf(n).trim() === '').length, 0, '每个开关都有名称');
    eq(switchNodes.filter(n => propOf(n, 'checked') === undefined).length, 0, '每个开关都暴露了 checked 状态');
    const storeFlags = await evaluate(`JSON.stringify({
      elderMode: Store.state.user.elderMode,
      hideDrugName: Store.state.user.hideDrugName,
      voiceEnabled: Store.state.user.voiceEnabled,
      demoFast: !!Store.state.user.demoFast,
      notify: Store.state.user.channels.notification,
      sound: Store.state.user.channels.sound,
      fullscreen: Store.state.user.channels.fullscreen,
      caregiver: Store.state.user.channels.caregiver
    })`);
    const flags = JSON.parse(storeFlags.value || '{}');
    const checkedByName = {};
    switchNodes.forEach(n => { checkedByName[nameOf(n)] = propOf(n, 'checked'); });
    eq(checkedByName['长者模式'], flags.elderMode, '「长者模式」开关的 checked 与数据一致');
    eq(checkedByName['隐藏药品名称'], flags.hideDrugName, '「隐藏药品名称」开关的 checked 与数据一致');
    eq(checkedByName['语音播报'], flags.voiceEnabled, '「语音播报」开关的 checked 与数据一致');
    eq(checkedByName['系统通知'], flags.notify, '「系统通知」开关的 checked 与数据一致');
    eq(checkedByName['提示音与震动'], flags.sound, '「提示音与震动」开关的 checked 与数据一致');
    eq(checkedByName['全屏强提醒'], flags.fullscreen, '「全屏强提醒」开关的 checked 与数据一致');
    eq(checkedByName['通知家属'], flags.caregiver, '「通知家属」开关的 checked 与数据一致');

    // 真实点击翻转 + 树里跟着变
    const clicked = await mouseClick('#screen .switch', 2);   // 第 3 个：语音播报
    ok(clicked, '对「语音播报」开关发出真实鼠标点击');
    const afterFlags = JSON.parse((await evaluate(`JSON.stringify({ voiceEnabled: Store.state.user.voiceEnabled })`)).value || '{}');
    eq(afterFlags.voiceEnabled, !flags.voiceEnabled, '点击后数据里的 voiceEnabled 翻转');
    const voiceNode = (await axTree()).find(n => roleOf(n) === 'switch' && nameOf(n) === '语音播报');
    eq(propOf(voiceNode, 'checked'), !flags.voiceEnabled, '可访问性树里的 checked 同步翻转（不是只有视觉变了）');

    /* ============================================================
     * 5. 对话框语义：弹层与全屏强提醒
     * ============================================================ */
    section('【5】对话框语义与焦点');
    await goto(BASE + '?auto=1&page=me');
    const closedOverlay = await axNodeOf('#overlay');
    ok(closedOverlay.ignored === true, '未打开的弹层不进可访问性树（读屏器不会念到不存在的内容）');
    const closedFs = await axNodeOf('#fsAlert');
    ok(closedFs.ignored === true, '未弹出的全屏强提醒不进可访问性树');

    // 5a. 打开弹层：role=dialog 有名字，焦点进弹层
    const disclaimerBtn = await evaluate(`(function(){
      var bs = document.querySelectorAll('#screen button');
      for (var i=0;i<bs.length;i++) if ((bs[i].innerText||'').indexOf('免责声明') !== -1) return i;
      return -1;
    })()`);
    await mouseClick('#screen button', disclaimerBtn.value);
    await sleep(300);
    const sheetOpen = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
    eq(sheetOpen.value, true, '点击「免责声明」后弹层已打开');
    const dlgNode = await axNodeOf('#overlay');
    eq(dlgNode.role, 'dialog', '弹层在树里是 dialog 角色');
    eq(dlgNode.modal, true, '弹层声明了 modal');
    ok(dlgNode.name.length > 0, `弹层有可访问名称（"${dlgNode.name}"）`);
    const focusInSheet = await activeEl();
    ok(focusInSheet.inSheet, '打开弹层后焦点已移入弹层（键盘与读屏器不会还停在被遮住的页面上）');

    // 5b. Esc 关闭后焦点归还给打开它的按钮
    await pressEsc();
    await sleep(300);
    const sheetClosed = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
    eq(sheetClosed.value, false, 'Esc 关闭了弹层');
    const focusBack = await activeEl();
    ok(focusBack && focusBack.text.indexOf('免责声明') !== -1,
      `Esc 关闭后焦点归还给打开它的按钮（实际在："${focusBack && focusBack.text}"）`);

    // 5c. 点遮罩关闭后同样归还
    await mouseClick('#screen button', disclaimerBtn.value);
    await sleep(300);
    const maskClick = await evaluate(`(function(){
      var ov = document.getElementById('overlay'), sh = document.getElementById('sheet');
      var or = ov.getBoundingClientRect(), sr = sh.getBoundingClientRect();
      // 在遮罩上、弹层上方找一条缝：那里点到的一定是遮罩本身
      var y = Math.max(or.top + 4, sr.top - 12);
      return (sr.top - or.top > 20) ? { x: Math.round(or.left + or.width / 2), y: Math.round(y) } : null;
    })()`);
    if (maskClick.value) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: maskClick.value.x, y: maskClick.value.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: maskClick.value.x, y: maskClick.value.y, button: 'left', clickCount: 1 });
      await sleep(400);
      const closed2 = await evaluate(`document.getElementById('overlay').classList.contains('show')`);
      eq(closed2.value, false, '点遮罩关闭了弹层');
      const focusBack2 = await activeEl();
      ok(focusBack2 && focusBack2.text.indexOf('免责声明') !== -1,
        `点遮罩关闭后焦点同样归还（实际在："${focusBack2 && focusBack2.text}"）`);
    } else {
      ok(false, '点遮罩关闭：没能定位到遮罩上方的空白区（布局变化，需要复核）');
    }

    // 5d. 全屏强提醒（L3）：alertdialog 必须真的接管焦点
    section('【5d】L3 全屏强提醒的 alertdialog 语义');
    await goto(BASE + '?auto=1&page=today');
    await resetFocus();
    await pressTab();   // 先把焦点放到页面里，模拟"用户正在操作"
    const focusBeforeL3 = await activeEl();
    ok(focusBeforeL3 && focusBeforeL3.tag === 'BUTTON', `触发前焦点在页面上（"${focusBeforeL3 && focusBeforeL3.text}"）`);
    await evaluate(`(async function(){
      var list = Store.state.reminders.filter(function(x){ return x.status === 'pending'; });
      list.sort(function(a,b){ return new Date(a.scheduledAt) - new Date(b.scheduledAt); });
      var p = list[0];
      p.scheduledAt = new Date(Date.now() - 20 * 60000).toISOString();  // 20 分钟前 → 反推出 L3
      p.level = 0; p.fireAt = null;
      Store.save(); ReminderEngine.reschedule();
      return true;
    })()`);
    await sleep(900);
    const fsShown = await evaluate(`document.getElementById('fsAlert').classList.contains('show')`);
    eq(fsShown.value, true, '逾期提醒按时间反推出 L3，全屏强提醒已弹出');
    const fsNode = await axNodeOf('#fsAlert');
    eq(fsNode.role, 'alertdialog', '全屏强提醒在树里是 alertdialog');
    eq(fsNode.modal, true, '全屏强提醒声明为 modal');
    ok(fsNode.name.length > 0, `alertdialog 有可访问名称（"${fsNode.name}"）`);
    ok(fsNode.description.length > 0, `alertdialog 有描述（"${fsNode.description}"）`);
    const focusAfterL3 = await activeEl();
    ok(focusAfterL3 && focusAfterL3.inFsAlert,
      `声明为 modal 的 alertdialog 必须接管焦点（实际焦点在："${focusAfterL3 && focusAfterL3.text}"）`);
    const fsBtnNames = (await axOf('#fsAlert button')).map(b => b.name.trim());
    eq(fsBtnNames.length, 2, `全屏强提醒的两个操作按钮都在树里（${fsBtnNames.join(' / ')}）`);
    ok(fsBtnNames.every(n => n.length > 0), '两个操作按钮都有名称');

    // 5e. 关闭后焦点归还
    await evaluate(`App.fsSnooze()`);
    await sleep(500);
    const fsGone = await evaluate(`document.getElementById('fsAlert').classList.contains('show')`);
    eq(fsGone.value, false, '操作后全屏强提醒关闭');
    const focusAfterFs = await activeEl();
    const fsFocusDetail = focusAfterFs
      ? `tag=${focusAfterFs.tag} id=${focusAfterFs.id} cls=${focusAfterFs.cls} inFsAlert=${focusAfterFs.inFsAlert}`
      : 'null';
    ok(focusAfterFs && !focusAfterFs.inFsAlert && focusAfterFs.tag !== 'BODY',
      `关闭全屏强提醒后焦点回到页面控件上（实际 ${fsFocusDetail}，文本："${focusAfterFs && focusAfterFs.text}"）`);

    /* ============================================================
     * 6. 键盘走查（docs/03 A-05 的可计算部分）
     * ============================================================ */
    section('【6】纯键盘走查：Tab 序列可见、有名、不卡死');
    await goto(BASE + '?auto=1&page=today');
    await resetFocus();
    const stops = [];
    for (let i = 0; i < 26; i++) {
      await pressTab();
      // 一次 evaluate 把"这一站是谁"问全：含一个自增标记，用来区分
      // 长得一模一样的元素——今日页有 4 个文字、class 完全相同的打卡按钮，
      // 只用 tag+class+text 做身份会误判成"键盘陷阱"。
      const d = await evaluate(`(function(){
        var a = document.activeElement;
        if (!a) return null;
        var rc = a.getBoundingClientRect();
        var body = (a === document.body);
        if (!body) {
          if (!a.__axSeq) { window.__axSeq = (window.__axSeq || 0) + 1; a.__axSeq = window.__axSeq; }
        }
        return {
          tag: a.tagName,
          cls: String(a.className || '').slice(0, 40),
          seq: body ? 0 : a.__axSeq,
          name: a.getAttribute ? (a.getAttribute('aria-label') || (a.innerText||'').replace(/\\s+/g,' ').trim() || a.getAttribute('title') || '') : '',
          text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
          w: body ? 0 : Math.round(rc.width),
          h: body ? 0 : Math.round(rc.height),
          vis: getComputedStyle(a).visibility
        };
      })()`);
      stops.push(d.value);
    }
    const allStops = stops.filter(Boolean);
    const bodyStops = allStops.filter(s => s.tag === 'BODY');
    const controlStops = allStops.filter(s => s.tag !== 'BODY');
    atMost(bodyStops.length, 4, `26 次 Tab 里有 ${bodyStops.length} 次落在 document.body（正常轮转，允许少量）`);
    atLeast(controlStops.length, 12, `Tab 走查到 ${controlStops.length} 个控件`);
    eq(controlStops.filter(s => s.w < 1 || s.h < 1).length, 0,
      '每个 Tab 到的控件都有可见尺寸（没有把焦点丢进 0×0 的隐藏元素）');
    eq(controlStops.filter(s => s.vis === 'hidden').length, 0,
      '每个 Tab 到的控件都不是 visibility:hidden');
    eq(controlStops.filter(s => !s.name).length, 0,
      '每个 Tab 到的控件都读得出名字（不会只念"按钮"或一片空白）');
    eq(controlStops.filter(s => GENERIC_NAMES.indexOf(s.name.trim()) !== -1).length, 0,
      'Tab 到的控件名字都不是通用词');

    const visitedText = controlStops.map(s => s.text).join('§') + '§' + controlStops.map(s => s.name).join('§');
    const tabsVisited = ['今日', '用药', '记录', '我的'].filter(t => visitedText.indexOf(t) !== -1);
    eq(tabsVisited.length, 4, `四个主导航页签都能用 Tab 到达（${tabsVisited.join('/')}）`);
    ok(/(我已服药|打卡)/.test(visitedText), '能纯键盘 Tab 到打卡按钮');

    // 无键盘陷阱：用自增标记判身份，连按 Tab 不会三次停在同一个元素上
    let trap = null;
    for (let i = 2; i < controlStops.length; i++) {
      if (controlStops[i - 2].seq === controlStops[i - 1].seq && controlStops[i - 1].seq === controlStops[i].seq) {
        trap = 'seq#' + controlStops[i].seq + ' ' + controlStops[i].cls + ' "' + controlStops[i].text + '"';
        break;
      }
    }
    eq(trap, null, '不存在键盘陷阱（连按 Tab 不会卡在同一个控件上）');
    // 正向验证判据本身是可用的：4 个同名打卡按钮必须是 4 个不同的元素，
    // 否则上面那条"无陷阱"只是因为判据失灵而恒真
    const doseSeqs = new Set(controlStops.filter(s => s.text === '我已服药').map(s => s.seq));
    atLeast(doseSeqs.size, 3, `4 个同名打卡按钮被识别为 ${doseSeqs.size} 个不同元素（判据没失灵）`);

    /* ============================================================
     * 7. aria-hidden 不得困住可聚焦元素
     * ============================================================ */
    section('【7】aria-hidden 子树里不得有可聚焦元素');
    const leaks = await evaluate(`(function(){
      var bad = [];
      document.querySelectorAll('[aria-hidden="true"]').forEach(function(h){
        var st = getComputedStyle(h);
        // display:none / visibility:hidden 的内容本来就不参与交互，不算泄漏
        if (st.display === 'none' || st.visibility === 'hidden') return;
        var f = h.querySelector('button,a[href],select,input,textarea,[tabindex]:not([tabindex="-1"]),[role="switch"]');
        if (f) bad.push((h.id || h.className || h.tagName) + ' → ' + (f.tagName + '.' + String(f.className).slice(0, 20)));
      });
      return bad;
    })()`);
    eq(leaks.value, [], '没有任何"读屏器读不到、键盘却 Tab 得进"的元素');

    /* ============================================================
     * 8. 全程无 JS 异常
     * ============================================================ */
    section('【8】全程无 JS 异常');
    eq(jsErrors, [], '整个无障碍树检查过程中没有未捕获异常或 console.error');

  } finally {
    try { ws && ws.close(); } catch { }
    proc.kill();
    await sleep(400);
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`无障碍树检查 总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('检查异常：', e && e.message ? e.message : e);
  process.exit(2);
});
