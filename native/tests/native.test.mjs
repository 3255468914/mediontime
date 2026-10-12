/**
 * native.test.mjs — 原生工程脚本的测试
 * 运行：node tests/native.test.mjs
 *
 * 覆盖：Android 清单补丁（幂等 / 保留原内容 / 缺锚点拒绝写入）与 CLI 行为、
 *       www 同步白名单（不把测试文件打进安装包）、
 *       **www 与 sw.js ASSETS 的漂移锁**（少打包一个文件必须构建期失败）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchManifest, REQUIRED_PERMISSIONS, REQUIRED_APP_ATTRS, runCli as runPatch } from '../scripts/patch-native.mjs';
import { listFiles, sync, diff, swAssets, missingAssets, runCli as runSync } from '../scripts/sync-www.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE = join(HERE, '..');
const APP_DIR = join(NATIVE, '..', 'app');

let pass = 0, fail = 0;
const failures = [];
function eq(a, e, name) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${E}\n      实际: ${A}`); }
}
function ok(c, name) { eq(!!c, true, name); }
function has(t, n, name) { eq(String(t).indexOf(n) !== -1, true, name); }
function group(t, fn) { console.log(`\n【${t}】`); return fn(); }

/** 收集 CLI 输出，替代真实终端 */
function collector() {
  const lines = [], errors = [];
  return {
    lines, errors,
    log: m => lines.push(String(m)),
    error: m => errors.push(String(m)),
    get stdout() { return lines.join('\n'); },
    get stderr() { return errors.join('\n'); }
  };
}

/** Capacitor `npx cap add android` 生成的真实清单（节选，结构一致） */
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:exported="true"
            android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

    <uses-permission android:name="android.permission.INTERNET" />

</manifest>
`;

const workDir = mkdtempSync(join(tmpdir(), 'mediontime-native-'));

/* ========== 1. 清单补丁 ========== */
group('1. AndroidManifest 权限补丁', () => {
  const r = patchManifest(MANIFEST);
  eq(r.added.length, REQUIRED_PERMISSIONS.length, `新增全部 ${REQUIRED_PERMISSIONS.length} 项权限`);
  REQUIRED_PERMISSIONS.forEach(p => {
    has(r.xml, `android:name="android.permission.${p.name}"`, `声明了 ${p.name}`);
  });
  eq(r.present.length, 0, '首次补丁没有已存在项');
  eq((r.xml.match(/<\/manifest>/g) || []).length, 1, 'manifest 闭合标签唯一，结构未被破坏');
  has(r.xml, '<application', '保留了 application 节点');
  has(r.xml, 'android.permission.INTERNET', '保留了原有权限声明');
  has(r.xml, 'android:name=".MainActivity"', '保留了 MainActivity 声明');

  // 幂等
  const again = patchManifest(r.xml);
  eq(again.added.length, 0, '重复执行不再新增（幂等）');
  eq(again.xml, r.xml, '重复执行输出与上次完全一致');
  eq(again.present.length, REQUIRED_PERMISSIONS.length, '重复执行时全部识别为已存在');

  // 不重复声明
  const timesIdempotent = patchManifest(patchManifest(patchManifest(MANIFEST).xml).xml).xml;
  REQUIRED_PERMISSIONS.forEach(p => {
    const n = (timesIdempotent.match(new RegExp('android.permission.' + p.name.replace(/\./g, '\\.'), 'g')) || []).length;
    eq(n, 1, `${p.name} 声明恰好出现 1 次`);
  });

  // 已存在的权限不应被再加一遍
  const partial = MANIFEST.replace(
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.VIBRATE" />'
  );
  const p2 = patchManifest(partial);
  eq(p2.present, ['VIBRATE'], '已存在的权限被识别出来');
  eq(p2.added.indexOf('VIBRATE'), -1, '已存在的权限不再重复新增');
  eq((p2.xml.match(/android\.permission\.VIBRATE/g) || []).length, 1, 'VIBRATE 仍只出现 1 次');

  // 换行/空格写法不同也应识别
  const spaced = MANIFEST.replace('</manifest>',
    '    <uses-permission\n        android:name="android.permission.WAKE_LOCK" />\n</manifest>');
  eq(patchManifest(spaced).present.indexOf('WAKE_LOCK') !== -1, true, '跨行书写的权限也能识别');

  // 拒绝不安全输入
  let threw = false;
  try { patchManifest('<manifest><application /></manifest>'.replace('</manifest>', '</x>')); }
  catch (e) { threw = true; has(e.message, '</manifest>', '缺锚点时报错信息指明原因'); }
  eq(threw, true, '缺少 </manifest> 锚点时拒绝写入');

  threw = false;
  try { patchManifest(''); } catch (e) { threw = true; }
  eq(threw, true, '空输入拒绝写入');
  threw = false;
  try { patchManifest(null); } catch (e) { threw = true; }
  eq(threw, true, '非字符串输入拒绝写入');
});

group('1b. AndroidManifest 应用属性补丁（明文 HTTP）', () => {
  // 背景：Android 9+ 默认禁止 App 内明文 HTTP；家属协同中继在局域网内是 http://。
  // 2026-10-11 真机联调实锤：手机浏览器能开 /api/health，App 内 fetch 全部
  // failed to fetch——根因是清单没有 usesCleartextTraffic。此组锁住这条声明。
  const r = patchManifest(MANIFEST);
  eq(r.addedAttrs.length, REQUIRED_APP_ATTRS.length, `新增全部 ${REQUIRED_APP_ATTRS.length} 项应用属性`);
  REQUIRED_APP_ATTRS.forEach(a => {
    has(r.xml, `${a.attr}="${a.value}"`, `application 声明了 ${a.attr}="${a.value}"`);
  });
  eq((r.xml.match(/<application/g) || []).length, 1, 'application 标签仍然只有一个（插入没破坏结构）');
  eq((r.xml.match(/usesCleartextTraffic/g) || []).length, 1, 'usesCleartextTraffic 恰好出现 1 次');
  has(r.xml, 'android:allowBackup="true"', 'application 原有属性保留');

  // 幂等
  const again = patchManifest(r.xml);
  eq(again.addedAttrs.length, 0, '重复执行不再新增（幂等）');
  eq(again.presentAttrs.length, REQUIRED_APP_ATTRS.length, '重复执行时识别为已存在');
  eq(again.xml, r.xml, '重复执行输出与上次完全一致');

  // 单引号写法也识别为已存在
  const singleQuoted = MANIFEST.replace('<application', "<application android:usesCleartextTraffic='true'");
  eq(patchManifest(singleQuoted).presentAttrs.length, REQUIRED_APP_ATTRS.length, '单引号写的属性也能识别');
});

group('1c. Capacitor 配置（混合内容放行）', () => {
  // Capacitor 5+ 的 androidScheme 默认是 https：App 页面源为 https://localhost，
  // WebView 会把页面发出的 http:// 请求当「混合内容」拦掉——
  // usesCleartextTraffic 只解除系统层禁令，管不到 WebView 这一层。
  // 局域网中继只能是 http://，缺这条则 App 内全部 failed to fetch
  // （浏览器直接打开 http 地址不受影响——真机联调实锤后纳入测试锁，P10-38）。
  const capCfg = JSON.parse(readFileSync(join(NATIVE, 'capacitor.config.json'), 'utf8'));
  ok(capCfg.android, 'capacitor.config.json 有 android 节');
  eq(capCfg.android.allowMixedContent, true, 'allowMixedContent 必须为 true（局域网 http 中继可达）');
  eq(capCfg.appId, 'cn.mediontime.app', 'appId 未被误改');
});

group('2. 权限清单本身的自洽性', () => {
  ok(REQUIRED_PERMISSIONS.length >= 6, '至少包含 6 项必需权限');
  REQUIRED_PERMISSIONS.forEach(p => {
    ok(/^[A-Z_]+$/.test(p.name), `${p.name} 命名合法`);
    ok(!!p.why, `${p.name} 说明了用途（便于日后审计）`);
    ok(!!p.platform, `${p.name} 标注了适用平台`);
  });
  eq(REQUIRED_PERMISSIONS.some(p => p.name === 'USE_EXACT_ALARM'), false,
    '故意不声明 USE_EXACT_ALARM（Google Play 限定闹钟/日历类应用，用药提醒会被拒审）');
  eq(REQUIRED_PERMISSIONS.some(p => p.name === 'SCHEDULE_EXACT_ALARM'), true,
    '改为声明 SCHEDULE_EXACT_ALARM 并引导用户单独授权');
  eq(REQUIRED_PERMISSIONS.some(p => p.name === 'RECEIVE_BOOT_COMPLETED'), true,
    '声明开机广播，保证重启后恢复提醒');
});

/* ========== 3. CLI 端到端 ========== */
group('3. 补丁脚本 CLI', () => {
  const target = join(workDir, 'AndroidManifest.xml');
  writeFileSync(target, MANIFEST);

  let io = collector();
  eq(runPatch(['--manifest', target, '--dry-run'], io), 0, '--dry-run 返回成功码');
  has(io.stdout, 'dry-run', '提示这是演练模式');
  eq(readFileSync(target, 'utf8'), MANIFEST, '--dry-run 未改动文件');

  io = collector();
  eq(runPatch(['--manifest', target, '--check'], io), 1, '未修补时 --check 以退出码 1 报出问题');
  has(io.stderr, '提醒或家属协同可能不工作', '说明后果而非只报错');

  io = collector();
  eq(runPatch(['--manifest', target], io), 0, '补丁执行成功');
  has(io.stdout, 'POST_NOTIFICATIONS', '输出列出新增权限');
  has(io.stdout, 'Android 13+', '输出带上适用平台');
  has(readFileSync(target, 'utf8'), 'android.permission.SCHEDULE_EXACT_ALARM', '文件真的被写入');

  io = collector();
  eq(runPatch(['--manifest', target, '--check'], io), 0, '修补后 --check 通过');
  has(io.stdout, '权限与应用属性声明齐备', '明确报告检查通过');

  io = collector();
  eq(runPatch(['--manifest', target], io), 0, '重复执行成功');
  has(io.stdout, '幂等', '重复执行明确提示无需改动');

  io = collector();
  eq(runPatch(['--manifest', join(workDir, '不存在.xml')], io), 2, '文件不存在时以退出码 2 报错');
  has(io.stderr, 'cap add android', '提示先去生成原生工程');

  io = collector();
  eq(runPatch(['--check'], io), 2, '缺少 --manifest 时以 2 退出');
  has(io.stderr, '用法', '输出用法说明');

  const broken = join(workDir, 'broken.xml');
  writeFileSync(broken, '<manifest><application /></manifest>'.replace('</manifest>', '</x>'));
  io = collector();
  eq(runPatch(['--manifest', broken], io), 2, '清单结构异常时拒绝写入');
  has(io.stderr, '</manifest>', '错误信息指明缺失的锚点');
});

/* ========== 4. www 同步 ========== */
group('4. www 同步（白名单打包）', () => {
  const files = listFiles(APP_DIR);
  ok(files.indexOf('index.html') !== -1, '包含 index.html');
  ok(files.indexOf('caregiver.html') !== -1, '包含 caregiver.html（家属端页面）');
  ok(files.indexOf('js/platform.js') !== -1, '包含 js/platform.js');
  ok(files.indexOf('js/app.js') !== -1, '包含 js/app.js');
  ok(files.indexOf('sw.js') !== -1, '包含 sw.js');
  ok(files.indexOf('manifest.json') !== -1, '包含 manifest.json');
  ok(files.indexOf('css/style.css') !== -1, '包含 css/style.css');
  eq(files.some(f => f.indexOf('tests/') === 0), false, '测试文件不会被打进安装包');
  eq(files.some(f => f.indexOf('README') !== -1), false, 'README 不会被打进安装包');
  ok(files.every(f => f.indexOf('..') === -1), '不存在越界路径');
  ok(files.every(f => f.indexOf('\\') === -1), '路径统一使用正斜杠（跨平台一致）');

  const out = join(workDir, 'www');
  const copied = sync(APP_DIR, out);
  eq(copied.length, files.length, '同步文件数与白名单一致');
  ok(existsSync(join(out, 'index.html')), 'index.html 已生成');
  ok(existsSync(join(out, 'caregiver.html')), 'caregiver.html 已生成');
  ok(existsSync(join(out, 'js', 'platform.js')), 'js/platform.js 已生成');
  eq(existsSync(join(out, 'tests')), false, '输出目录中没有 tests');
  eq(existsSync(join(out, 'README.md')), false, '输出目录中没有 README.md');
  eq(readFileSync(join(out, 'js', 'scheduler.js'), 'utf8'),
    readFileSync(join(APP_DIR, 'js', 'scheduler.js'), 'utf8'), '内容逐字节一致');

  eq(diff(APP_DIR, out).inSync, true, '同步后 diff 判定为一致');

  // 源文件变了要能检出
  writeFileSync(join(out, 'index.html'), '<html>被改坏了</html>');
  const d = diff(APP_DIR, out);
  eq(d.inSync, false, '内容被改动后 diff 判定为不一致');
  eq(d.changed, ['index.html'], '精确定位到被改动的文件');

  eq(sync(APP_DIR, out).length > 0, true, '重新同步可覆盖回正确内容');
  eq(diff(APP_DIR, out).inSync, true, '重新同步后恢复一致');

  // 源里删掉的文件不应残留在安装包中
  const extra = join(out, 'js', '已废弃.js');
  writeFileSync(extra, '遗留文件');
  eq(diff(APP_DIR, out).stale, ['js/已废弃.js'], '检出安装包中的多余文件');
  sync(APP_DIR, out);
  eq(existsSync(extra), false, '重新同步会清理多余文件（旧版本不残留）');
});

/* ========== 4.1 www 与 sw.js ASSETS 的漂移锁 ==========
 *
 * 背景（真缺陷）：P8 加家属端页面时，只往 `app/sw.js` 的 ASSETS 里加了
 * `./caregiver.html`，**没改 sync-www.mjs 的白名单**，于是 `www/`（→ 安装包）
 * 里没有那个页面：家属打开就是 404，而患者端照样显示"家属协同已开"。
 * 102 项测试全绿——因为没人断言过这件事。
 *
 * 修法不是"再补一个文件名"（那只是把这次的漏补上，下次还会漏），
 * 而是**用 sw.js 反查打包结果**：凡是 SW 说"我要缓存它"的本地资源，
 * 打包输出里就必须有。两份清单从此不能再各自漂移。
 */
group('4.1 www 与 sw.js ASSETS 的漂移锁', () => {
  const assets = swAssets(APP_DIR);

  // 反向断言：先证明这把锁本身是有效的。
  // 若解析哪天失败却返回空数组，下面的校验会恒为通过——那是"判据失灵"，比缺陷更隐蔽。
  ok(assets.length > 0, '能从 sw.js 解析出非空的 ASSETS 清单（否则下面的断言会恒为真）');
  ok(assets.indexOf('caregiver.html') !== -1, 'sw.js 的 ASSETS 确实列了 caregiver.html（这条漂移锁因此有意义）');
  ok(assets.indexOf('index.html') !== -1, 'ASSETS 含 index.html');
  ok(assets.every(f => f.indexOf('//') === -1), '只取本地相对资源，不含外链 URL');

  const out = join(workDir, 'www-assets');
  sync(APP_DIR, out);
  eq(missingAssets(APP_DIR, out), [], 'sw.js 要求缓存的每个本地资源都在打包输出里');

  // 删掉一个 → 必须被检出（证明 missingAssets 真的在工作，不是恒空）
  rmSync(join(out, 'caregiver.html'));
  eq(missingAssets(APP_DIR, out), ['caregiver.html'], '打包输出缺文件时能被精确指出');

  // --check 不做同步，所以能直接把"输出里缺了文件"报出来
  const io1 = collector();
  eq(runSync(['--out', out, '--check'], io1), 1, '--check 以 1 报出缺失');
  has(io1.stderr, 'caregiver.html', '错误信息指名缺失的文件');

  sync(APP_DIR, out);
  const io2 = collector();
  eq(runSync(['--out', out], io2), 0, '补齐后同步恢复正常');
  has(io2.stdout, 'sw.js 要求的', '输出里说明已按 sw.js 反向核对');

  // 真正要防的那一类：**白名单自己漏了**（P8 就是这么漏的）。
  // 这时 sync 也补不上来，必须构建期硬失败，而不是打印一行然后继续。
  const forgot = join(workDir, 'app-forgot-a-file');
  mkdirSync(forgot, { recursive: true });
  writeFileSync(join(forgot, 'index.html'), '<html></html>');
  writeFileSync(join(forgot, 'sw.js'), "const ASSETS = ['./index.html', './forgot.html'];\n");
  const io3 = collector();
  eq(runSync(['--src', forgot, '--out', join(workDir, 'www-forgot')], io3), 1,
    '白名单漏了 sw.js 要求的文件时，同步以退出码 1 硬失败（不允许静默通过）');
  has(io3.stderr, 'forgot.html', '错误信息指名缺失的文件');
  has(io3.stderr, '404', '说清后果是"装到手机上会 404"');

  // 解析失败必须抛错，不能悄悄返回空清单
  const badApp = join(workDir, 'bad-app');
  mkdirSync(badApp, { recursive: true });
  writeFileSync(join(badApp, 'sw.js'), '// 这份 sw.js 里没有 ASSETS 清单');
  let threw = null;
  try { swAssets(badApp); } catch (e) { threw = e; }
  ok(threw !== null, 'sw.js 里找不到 ASSETS 时抛错');
  has(threw && threw.message, 'ASSETS', '错误信息指明是 ASSETS 解析失败');
});

group('5. 同步脚本 CLI', () => {
  const dest = join(workDir, 'www-cli');

  let io = collector();
  eq(runSync(['--out', dest], io), 0, '同步返回成功码');
  has(io.stdout, '已同步', '输出同步结果');
  has(io.stdout, 'cap sync', '提示下一步命令');
  ok(existsSync(join(dest, 'index.html')), '输出目录已生成');

  io = collector();
  eq(runSync(['--out', dest, '--check'], io), 0, '同步后 --check 通过');

  writeFileSync(join(dest, 'index.html'), 'x');
  io = collector();
  eq(runSync(['--out', dest, '--check'], io), 1, '内容不一致时 --check 以 1 报出');
  has(io.stderr, 'index.html', '指出不一致的文件');

  io = collector();
  eq(runSync(['--src', join(workDir, '不存在的app'), '--out', dest], io), 2, '源目录不存在时报错退出');
  has(io.stderr, '找不到源目录', '错误信息说明原因');
});

/* ========== 汇总 ========== */
try { rmSync(workDir, { recursive: true, force: true }); } catch { }
console.log('\n' + '─'.repeat(52));
console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
