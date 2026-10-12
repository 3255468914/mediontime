#!/usr/bin/env node
/**
 * patch-native.mjs — 为 Capacitor 生成的 Android 工程补齐「提醒必达」所需的声明
 *
 * 为什么需要这一步：`npx cap add android` 生成的 AndroidManifest.xml 只带最基础的
 * 权限。**没有这些声明，提醒会静默地不准时**——不报错、不弹窗，只是晚到，
 * 这对用药提醒是最危险的失败方式（用户以为设好了）。
 *
 * 本脚本是幂等的：重复执行不会产生重复条目，也不会动清单里的其它内容。
 *
 * 用法：
 *   node scripts/patch-native.mjs --manifest android/app/src/main/AndroidManifest.xml
 *   node scripts/patch-native.mjs --manifest <path> --check     # 只检查，有缺则退出码 1
 *   node scripts/patch-native.mjs --manifest <path> --dry-run   # 打印结果但不写盘
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 必须声明的权限。
 *
 * 注意这里**故意没有** USE_EXACT_ALARM：Google Play 把它限制为「闹钟/日历类应用」
 * 专用，用药提醒不属于该类别，声明了会被拒审。正确做法是声明 SCHEDULE_EXACT_ALARM
 * 并由用户在「闹钟和提醒」设置里单独授权——见 platform.js 的 exactAlarmState()。
 */
export const REQUIRED_PERMISSIONS = [
  { name: 'POST_NOTIFICATIONS', platform: 'Android 13+', why: '不授权则通知一律不展示' },
  { name: 'SCHEDULE_EXACT_ALARM', platform: 'Android 12+', why: '不声明则提醒时刻不精确，会被系统推迟' },
  { name: 'RECEIVE_BOOT_COMPLETED', platform: '全部', why: '开机广播，设备重启后自动恢复待触发提醒' },
  { name: 'VIBRATE', platform: '全部', why: '震动提醒（第 2、3 级）' },
  { name: 'WAKE_LOCK', platform: '全部', why: 'Doze 模式下短暂唤醒以投递提醒' },
  { name: 'USE_FULL_SCREEN_INTENT', platform: 'Android 14+', why: '锁屏全屏强提醒（第 3 级）' }
];

const FULL = n => 'android.permission.' + n;

/**
 * 必须写在 <application> 标签上的属性。
 *
 * usesCleartextTraffic：Android 9+（API 28+）默认禁止 App 发起明文 HTTP 请求。
 * 家属协同的中继在局域网内只能是 http://（Web Push 才需要 HTTPS），
 * 不加这条声明，App 里的 fetch 会全部 failed to fetch——而手机浏览器手动访问
 * 同一地址却正常，因为浏览器不受该策略限制。2026-10-11 真机联调实锤：
 * 浏览器 health 通、App 连接失败，根因即此。
 */
export const REQUIRED_APP_ATTRS = [
  {
    attr: 'android:usesCleartextTraffic',
    value: 'true',
    why: 'Android 9+ 默认禁明文 HTTP；局域网中继是 http://，不加则家属协同在 App 内全部失败'
  }
];

/**
 * 在清单的 </manifest> 之前补齐缺失的权限声明，并补齐 <application> 缺失的属性。
 * @param {string} xml AndroidManifest.xml 原文
 * @returns {{xml:string, added:string[], present:string[], addedAttrs:Object[], presentAttrs:Object[]}}
 */
export function patchManifest(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('清单内容为空，拒绝写入');
  }
  if (xml.indexOf('</manifest>') === -1) {
    throw new Error('清单缺少 </manifest> 锚点，无法安全插入——请确认传入的是 AndroidManifest.xml');
  }

  const added = [], present = [];
  const addedAttrs = [], presentAttrs = [];
  let out = xml;

  for (const p of REQUIRED_PERMISSIONS) {
    const re = new RegExp('<uses-permission[^>]*android:name="' + FULL(p.name).replace(/\./g, '\\.') + '"');
    if (re.test(out)) { present.push(p.name); continue; }
    added.push(p.name);
    out = out.replace('</manifest>', '    <uses-permission android:name="' + FULL(p.name) + '" />\n</manifest>');
  }

  for (const a of REQUIRED_APP_ATTRS) {
    // 属性可能以任意顺序/引号风格出现在 <application 标签内；按 属性名="值" 宽松匹配
    const re = new RegExp('<application[^>]*' + a.attr.replace(/:/g, '\\:') + '=["\']' + a.value + '["\']');
    if (re.test(out)) { presentAttrs.push(a); continue; }
    addedAttrs.push(a);
    // <application 在清单里恰好出现一次（<manifest 是根标签，不会撞上）；
    // 直接在标签名后插入，保持原有属性不动
    out = out.replace('<application', '<application\n        ' + a.attr + '="' + a.value + '"');
  }

  return { xml: out, added, present, addedAttrs, presentAttrs };
}

/* ---------- CLI ---------- */

export function parseArgs(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
  return { manifest: get('--manifest'), check: !!get('--check'), dry: !!get('--dry-run') };
}

/**
 * CLI 主流程。把逻辑放在可导出的函数里而不是直接写在入口块中，
 * 好处是测试可以直接调用、断言返回码与输出，无需起子进程。
 * @param {string[]} argv 参数（不含 node 与脚本路径）
 * @param {{log:Function, error:Function}} io 输出通道
 * @returns {number} 退出码
 */
export function runCli(argv, io = console) {
  const args = parseArgs(argv);

  if (!args.manifest || args.manifest === true) {
    io.error('用法：node scripts/patch-native.mjs --manifest <AndroidManifest.xml 路径> [--check] [--dry-run]');
    return 2;
  }
  if (!existsSync(args.manifest)) {
    io.error(`✗ 找不到清单文件：${args.manifest}`);
    io.error('  请先执行：npx cap add android');
    return 2;
  }

  let result;
  try {
    result = patchManifest(readFileSync(args.manifest, 'utf8'));
  } catch (e) {
    io.error('✗ ' + e.message);
    return 2;
  }

  result.added.forEach(n => {
    const meta = REQUIRED_PERMISSIONS.find(p => p.name === n);
    io.log(`  + ${FULL(n)}   （${meta.platform}）${meta.why}`);
  });
  result.present.forEach(n => io.log(`  = ${FULL(n)}   已存在，跳过`));
  result.addedAttrs.forEach(a => {
    io.log(`  + <application ${a.attr}="${a.value}"   ${a.why}`);
  });
  result.presentAttrs.forEach(a => io.log(`  = <application ${a.attr}="${a.value}"   已存在，跳过`));

  const missing = result.added.length + result.addedAttrs.length;
  if (args.check) {
    if (missing) {
      io.error(`\n✗ 还缺 ${missing} 项声明（权限/应用属性），提醒或家属协同可能不工作`);
      return 1;
    }
    io.log('\n✓ 权限与应用属性声明齐备');
    return 0;
  }

  if (!missing) {
    io.log('\n✓ 无需改动（幂等）');
    return 0;
  }

  if (args.dry) {
    io.log(`\n— dry-run：将新增 ${missing} 项，未写入磁盘`);
    return 0;
  }

  writeFileSync(args.manifest, result.xml);
  io.log(`\n✓ 已写入 ${args.manifest}（新增 ${missing} 项）`);
  io.log('  下一步：npm run sync');
  return 0;
}

/** 仅在作为 CLI 直接执行时跑主流程；被测试 import 时只导出函数 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  process.exit(runCli(process.argv.slice(2)));
}
