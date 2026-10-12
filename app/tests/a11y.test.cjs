/**
 * a11y.test.cjs — 无障碍与长者模式的无回归锁
 * 运行：node tests/a11y.test.cjs
 *
 * 为什么需要它：
 *   目标用户是 55+ 慢病患者。字号、对比度、点击区这些参数被后人"顺手调亮一点"之后，
 *   界面照样能跑、其他测试照样全绿，但对真正要用的老人就是不能用。
 *   所以把 WCAG 2.1 AA 的硬指标直接写成断言：
 *     · 关键前景/背景组合对比度 ≥ 4.5:1（用真实相对亮度公式算，不是拍脑袋）
 *     · 正文最小字号 ≥ 12px（.8em @ 15px 基准）
 *     · 点击区 ≥ 44px
 *     · 长者模式必须真的改变对比度，而不是只改字号（改之前界面在说谎）
 *     · 关键控件有 role / aria-*，导航是真 <button>（键盘可用）
 *
 * 零依赖，纯静态解析 CSS / HTML / app.js。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

const BASE_PX = 15;    // .phone 默认字号
const ELDER_PX = 20;   // .phone.elder
const MIN_EM = 0.8;    // 0.8em × 15px = 12px
const AA = 4.5;        // WCAG 2.1 AA 小字阈值

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
function notHas(text, needle, name) { eq(String(text).indexOf(needle) === -1, true, name); }
function atLeast(actual, min, name) {
  if (actual >= min) { pass++; console.log(`  ✓ ${name}（${actual}）`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      要求 ≥ ${min}，实际 ${actual}`); }
}

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

/* ---------- 颜色与对比度 ---------- */

function toRgb(c) {
  c = String(c).trim().toLowerCase();
  if (c[0] === '#') {
    let hx = c.slice(1);
    if (hx.length === 3) hx = hx.split('').map(x => x + x).join('');
    return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) return m[1].split(',').slice(0, 3).map(x => parseFloat(x));
  throw new Error('无法解析颜色: ' + c);
}
function relLum(rgb) {
  const c = rgb.map(v => {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const la = relLum(toRgb(a)), lb = relLum(toRgb(b));
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** 取出某个选择器的规则体。
 *  必须锚定行首：否则 indexOf('.btn {') 会先命中 '.phone.elder .btn {'
 *  这种「包含子串」的规则，拿到的是长者模式覆盖块而不是主规则。 */
function ruleBody(selector) {
  // 允许传入带或不带结尾 "{" 的选择器
  const sel = String(selector).replace(/\s*\{$/, '').trim();
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^[ \\t]*' + esc + '\\s*\\{', 'm');
  const m = re.exec(CSS);
  if (!m) return '';
  const s = CSS.indexOf('{', m.index);
  const e = CSS.indexOf('}', s);
  return s === -1 || e === -1 ? '' : CSS.slice(s + 1, e);
}
function readVars(body) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}

const ROOT_VARS = readVars(ruleBody(':root'));
const ELDER_VARS = readVars(ruleBody('.phone.elder {'));

/** 支持 var(--x) 与裸写 --x 两种引用 */
function resolve(v, table) {
  const t = table || ROOT_VARS;
  const s = String(v).trim();
  const m = s.match(/var\(\s*(--[a-z0-9-]+)\s*\)/i);
  if (m) return t[m[1]] != null ? t[m[1]] : ROOT_VARS[m[1]];
  if (/^--[a-z0-9-]+$/i.test(s)) return t[s] != null ? t[s] : ROOT_VARS[s];
  return s;
}
function pair(a, b, table) {
  return contrast(resolve(a, table), resolve(b, table));
}

/* ---------- 测试 ---------- */

async function main() {
  console.log('无障碍测试（静态解析 CSS / HTML / app.js，对比度按 WCAG 相对亮度公式实算）');

  /* ---------- 1. 配色对比度 ---------- */
  await group('1. 关键配色对比度（WCAG 2.1 AA，小字需 ≥ 4.5:1）', () => {
    const PAIRS = [
      ['正文 / 卡片', '--text', '--card'],
      ['次要文字 / 卡片', '--sub', '--card'],
      ['次要文字 / 页面底色', '--sub', '--bg'],
      ['主色文字 / 卡片', '--primary', '--card'],
      ['按时色 / 卡片', '--ok', '--card'],
      ['延迟色 / 卡片', '--warn', '--card'],
      ['漏服色 / 卡片', '--danger', '--card'],
      ['按时徽标 / 徽标底', '--ok', '--ok-soft'],
      ['延迟徽标 / 徽标底', '--warn', '--warn-soft'],
      ['漏服徽标 / 徽标底', '--danger', '--danger-soft'],
      ['白字 / 主按钮', '#ffffff', '--primary'],
      ['白字 / 成功按钮', '#ffffff', '--ok'],
      ['免责声明正文 / 声明底', '#4a5461', '#f7f9fb']
    ];
    PAIRS.forEach(([name, fg, bg]) => atLeast(pair(fg, bg), AA, name));
  });

  /* ---------- 2. 字号下限 ---------- */
  await group('2. 字号下限（≥ 0.8em，即 15px 基准下 12px）', () => {
    const sizeRe = /font-size:\s*([0-9]*\.?[0-9]+)em/g;
    function collect(src, label) {
      const out = [];
      let m;
      while ((m = sizeRe.exec(src))) out.push({ v: parseFloat(m[1]), label });
      return out;
    }
    const sizes = collect(CSS, 'style.css').concat(collect(APP, 'app.js'));

    ok(sizes.length > 30, `采到 ${sizes.length} 处 em 字号`);

    const tooSmall = sizes.filter(s => s.v < MIN_EM)
      .map(s => `${s.label}: ${s.v}em ≈ ${Math.round(s.v * BASE_PX)}px`);
    eq(tooSmall, [], `没有低于 ${MIN_EM}em 的字号（${Math.round(MIN_EM * BASE_PX)}px）`);

    eq(Math.round(MIN_EM * BASE_PX), 12, '最小字号折算为 12px');

    // 长者模式基准字号
    has(ruleBody('.phone.elder {'), 'font-size: ' + ELDER_PX + 'px', `长者模式基准字号为 ${ELDER_PX}px`);
    atLeast(MIN_EM * ELDER_PX, 16, '长者模式下最小字号 ≥ 16px');

    // 长者模式下信息不能被单行省略截掉
    ok(/\.phone\.elder \.dose-meta[^{]*\{[^}]*white-space:\s*normal/.test(CSS),
      '长者模式下 meta 行允许换行（不截断用药细节）');
  });

  /* ---------- 3. 点击区 ---------- */
  await group('3. 点击区（≥ 44px，长者友好）', () => {
    has(ruleBody(':root'), '--tap: 44px', '定义了统一的最小点击区变量 --tap: 44px');

    const iconBtn = ruleBody('.icon-btn {');
    has(iconBtn, 'max(2.2em, var(--tap))', '图标按钮宽高取 max(2.2em, 44px)');
    notHas(iconBtn, 'width: 2.2em;', '不再使用固定 2.2em 宽高（15px 下只有 33px）');

    has(ruleBody('.btn {'), 'min-height: var(--tap)', '主按钮最小高度 44px');
    has(ruleBody('.btn.sm {'), 'min-height: 40px', '小按钮最小高度 40px');

    // 开关本体只有 48×28，靠 ::before 把热区撑到 64×44
    const swBody = ruleBody('.switch {');
    has(swBody, 'width: 48px', '开关宽度 48px');
    has(swBody, 'height: 28px', '开关高度 28px');
    ok(/\.switch::before\s*\{[^}]*inset:\s*-8px/.test(CSS), '开关用 ::before 把点击热区外扩 8px（48+16=64 宽，28+16=44 高）');

    has(ruleBody('.phone.elder .icon-btn'), 'max(2.2em, 56px)', '长者模式下图标按钮加大到 56px');
  });

  /* ---------- 4. 长者模式必须真的改对比度 ---------- */
  await group('4. 长者模式兑现「高对比度」承诺', () => {
    ok(ELDER_VARS['--sub'], '长者模式覆盖了 --sub');
    ok(ELDER_VARS['--line'], '长者模式覆盖了 --line（分隔更清楚）');

    const normalSub = pair('--sub', '--card');
    const elderSub = pair('--sub', '--card', ELDER_VARS);
    atLeast(elderSub, normalSub + 1, `长者模式下次要文字对比度明显提升（${normalSub} → ${elderSub}）`);
    atLeast(elderSub, 7, '长者模式下次要文字达 AAA 级（≥ 7:1）');

    const elderBody = ruleBody('.phone.elder {');
    has(elderBody, 'font-size: ' + ELDER_PX + 'px', '长者模式放大基准字号');
    has(CSS, '.phone.elder .card { border-width: 1.5px', '长者模式加重卡片描边');
    has(CSS, '.phone.elder .btn { min-height: 56px', '长者模式加大按钮高度');
    has(CSS, '.phone.elder .overlay { backdrop-filter: none', '长者模式去掉毛玻璃（减少视觉层）');

    // 界面文案必须与实际做到的事一致
    has(APP, '超大字号、高对比度、更大点击区', '设置页文案与实现一致');
    notHas(APP, '超大字号、高对比度、简化层级', '已删除未实现的「简化层级」描述');
  });

  /* ---------- 5. 语义与键盘可达性 ---------- */
  await group('5. 语义与键盘可达性', () => {
    has(HTML, '<nav class="tabbar"', '底部导航用 <nav>');
    has(HTML, 'aria-label="主导航"', '导航有可访问名称');
    has(HTML, '<button type="button" class="tab active"', '页签是真 <button>（键盘 Tab/Enter 可用）');
    has(HTML, 'aria-current="page"', '当前页签初始带 aria-current');
    eq((HTML.match(/<button type="button" class="tab[ "]/g) || []).length, 4, '四个页签都是 button');

    has(HTML, 'role="dialog" aria-modal="true"', '弹层作为对话框');
    has(HTML, 'role="status" aria-live="polite" aria-atomic="true"', 'Toast 用 role=status 播报');
    has(HTML, 'role="alertdialog"', '全屏强提醒用 alertdialog（读屏器立即播报）');
    has(HTML, 'aria-labelledby="fsName"', '全屏强提醒有关联标题');

    has(HTML, 'aria-hidden="true" focusable="false"', '装饰性 SVG 对读屏器隐藏');
    has(APP, 'aria-hidden="true" focusable="false"', 'app.js 生成的装饰性 SVG 同样处理');

    has(APP, "role=\"switch\" tabindex=\"0\"", '开关是 role=switch 且可聚焦');
    has(APP, "aria-checked=\"", '开关暴露 aria-checked 状态');
    has(APP, 'function initA11y', '存在键盘处理 initA11y');
    has(APP, 'initA11y();', 'boot 中调用了 initA11y');
    has(APP, "e.key === 'Escape'", 'Esc 可关闭弹层');
    has(APP, "t.classList.contains('switch')", '开关支持 Enter / 空格激活');

    // 图标按钮必须是 button 且带可访问名称
    notHas(APP, '<div class="icon-btn', '图标按钮不再用 div');
    has(APP, '<button type="button" class="icon-btn', '图标按钮是真 <button>');
    has(APP, 'aria-pressed="', '切换型图标按钮暴露 aria-pressed');
    atLeast((APP.match(/aria-label="[^"]*" title=/g) || []).length, 4, '每个图标按钮都有 aria-label');

    has(APP, "t.setAttribute('aria-current', 'page')", 'render 时同步 aria-current');

    // 对话框焦点管理
    has(APP, 'sh.focus()', '打开弹层时把焦点移入');
    has(APP, 'lastFocus', '关闭弹层时把焦点还回去');
    has(APP, "ov.setAttribute('aria-labelledby'", '弹层自动关联标题');
  });

  /* ---------- 6. 焦点可见与降低动效 ---------- */
  await group('6. 焦点可见与 prefers-reduced-motion', () => {
    ok(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/.test(CSS), '存在全局 :focus-visible 焦点环');
    ok(/input:focus-visible[^{]*\{[^}]*outline:\s*3px/.test(CSS), '输入框有可见焦点环');
    notHas(CSS, 'input:focus, input:focus { outline: none;', '不再把输入框焦点环直接抹掉');

    ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(CSS), '存在 prefers-reduced-motion 适配');
    ok(/prefers-reduced-motion[^}]*animation-duration:\s*\.001ms\s*!important/.test(CSS.replace(/\n/g, ' ')),
      '降低动效时压掉动画时长');
    ok(/@media \(prefers-reduced-motion[^@]*\.fs-bell\s*\{\s*animation:\s*none/.test(CSS.replace(/\n/g, ' ')),
      '降低动效时停掉铃铛抖动');
  });

  /* ---------- 7. 假链接回归 ---------- */
  await group('7. 回归：不再有「看着能点、点了没反应」的行', () => {
    has(APP, 'onclick="App.showDisclaimer()"', '免责声明行有真实处理函数');
    has(APP, 'onclick="App.showPrivacy()"', '隐私政策行有真实处理函数');
    has(APP, 'showDisclaimer: showDisclaimer, showPrivacy: showPrivacy', '两个函数已挂到 App 上');

    // 旧的死链形态：带 › 箭头却没有 onclick
    notHas(APP, '免责声明</div></div><span class="chev">', '旧的免责声明死链已移除');
    notHas(APP, '隐私政策</div></div><span class="chev">', '旧的隐私政策死链已移除');

    has(APP, '我们没有服务器。', '隐私政策有正文内容（不再是占位）');
    has(APP, '应用申请的权限与用途', '隐私政策说明了权限用途');
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
