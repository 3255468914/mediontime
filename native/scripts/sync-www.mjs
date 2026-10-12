#!/usr/bin/env node
/**
 * sync-www.mjs — 把 app/ 的运行时文件同步到 native/www/（Capacitor 的 webDir）
 *
 * 为什么不直接把 capacitor.config.json 的 webDir 指向 ../app：
 * 因为 app/tests 与 app/README.md 不该打进安装包，而 Capacitor 会对 webDir
 * 整目录做拷贝。所以先用白名单复制出一份干净的 www/。
 *
 * 用法：
 *   node scripts/sync-www.mjs                      # 同步到 native/www
 *   node scripts/sync-www.mjs --out <dir>          # 指定输出目录（测试用）
 *   node scripts/sync-www.mjs --check              # 只比对，不一致则退出码 1
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = join(HERE, '..', '..', 'app');
const DEFAULT_OUT = join(HERE, '..', 'www');

/** 运行时会用到的文件；其余（tests/、README.md 等）不打包
 *
 * ⚠️ `caregiver.html` 必须在这里。
 * P8 引入家属端页面时，只改了 `app/sw.js` 的 ASSETS，**忘了改这份白名单**，
 * 于是 `www/`（→ 安装包 assets）里没有它：家属打开就是 404，
 * 而患者端在原生 App 里照样能配置中继、照样显示邀请码。
 * 界面在说"家属协同已开"，安装包里那个页面根本不存在。
 *
 * 为什么会漏这么久：**这是第二份平行的清单**（第一份在 `app/sw.js` 的 ASSETS）。
 * 两份清单各自维护，就一定会漂移。所以下面加了 `swAssets()`/`missingAssets()`，
 * 用 sw.js 反查打包结果——让"少打包一个文件"变成**构建期硬失败**，而不是上线后才发现。

 * 注：`tests/` 与 `README.md` 仍然不进安装包。 */
export const INCLUDE_FILES = ['index.html', 'caregiver.html', 'sw.js', 'manifest.json'];
export const INCLUDE_DIRS = ['css', 'js'];
/** 这些即使在 js/ 里也不该进安装包 */
export const EXCLUDE_NAMES = ['tests'];

/**
 * 从 `app/sw.js` 解析出 Service Worker 要求缓存的**本地**资源清单。
 *
 * 用途：交叉校验打包结果。凡是被 SW 列进 ASSETS 的文件，
 * 部署后必须能取到——否则 SW 会去缓存一个 404。
 *
 * 解析不到时**抛错而不是返回空数组**：空数组会让下面的校验恒为通过，
 * 那是本项目已经踩过两次的坑（判据失灵 → 断言永远为真）。
 * @param {string} src app/ 目录
 * @returns {string[]} 相对路径，如 ['index.html','caregiver.html','css/style.css']
 */
export function swAssets(src) {
  const p = join(src, 'sw.js');
  if (!existsSync(p)) throw new Error('找不到 ' + p);
  const code = readFileSync(p, 'utf8');
  const block = /const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(code);
  if (!block) {
    throw new Error('未能从 sw.js 解析出 ASSETS 清单——若 sw.js 结构变了，请同步更新 swAssets()');
  }
  const urls = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1]))) {
    if (m[1].startsWith('./')) urls.push(m[1].slice(2));
  }
  if (!urls.length) throw new Error('从 sw.js 解析出的 ASSETS 为空——拒绝用空清单做校验');
  return urls;
}

/** sw.js 要求缓存、却不在打包输出里的文件（即"装到手机上会 404 的文件"） */
export function missingAssets(src, out) {
  return swAssets(src).filter(rel => !existsSync(join(out, rel)));
}

export function listFiles(src) {
  const out = [];
  for (const f of INCLUDE_FILES) {
    const p = join(src, f);
    if (existsSync(p)) out.push(f);
  }
  for (const d of INCLUDE_DIRS) {
    walk(join(src, d), d, out);
  }
  return out.sort();
}

function walk(absDir, relDir, out) {
  if (!existsSync(absDir)) return;
  for (const name of readdirSync(absDir).sort()) {
    if (EXCLUDE_NAMES.includes(name)) continue;
    const abs = join(absDir, name);
    const rel = join(relDir, name).replace(/\\/g, '/');
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
}

export function diff(src, out) {
  const files = listFiles(src);
  const missing = [], stale = [], changed = [];
  for (const rel of files) {
    const dst = join(out, rel);
    if (!existsSync(dst)) { missing.push(rel); continue; }
    if (readFileSync(join(src, rel), 'utf8') !== readFileSync(dst, 'utf8')) changed.push(rel);
  }
  for (const rel of listFiles(out)) {
    if (files.indexOf(rel) === -1) stale.push(rel);
  }
  return { files, missing, changed, stale, inSync: !missing.length && !changed.length && !stale.length };
}

export function sync(src, out) {
  const files = listFiles(src);
  mkdirSync(out, { recursive: true });
  for (const rel of files) {
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(join(src, rel)));
  }
  // 清掉已经不在源里的旧文件，避免旧版本残留在安装包里
  for (const rel of listFiles(out)) {
    if (files.indexOf(rel) === -1) { rmSync(join(out, rel), { force: true }); }
  }
  return files;
}

/**
 * CLI 主流程。抽成可导出函数，测试可直接调用、断言返回码与输出，无需起子进程。
 * @returns {number} 退出码
 */
export function runCli(argv, io = console) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
  const src = get('--src') || DEFAULT_SRC;
  const dest = get('--out') || DEFAULT_OUT;

  if (typeof src !== 'string' || !existsSync(src)) {
    io.error(`✗ 找不到源目录：${src}`);
    return 2;
  }

  if (argv.includes('--check')) {
    const d = diff(src, dest);
    const missA = missingAssets(src, dest);
    if (d.inSync && !missA.length) { io.log(`✓ www 与 app 一致（${d.files.length} 个文件）`); return 0; }
    d.missing.forEach(f => io.error(`  - 缺少 ${f}`));
    d.changed.forEach(f => io.error(`  ~ 内容不一致 ${f}`));
    d.stale.forEach(f => io.error(`  + 多余 ${f}`));
    if (missA.length) {
      io.error('\n✗ 以下资源被 sw.js 要求缓存，却不在打包输出里（部署后会 404）：');
      missA.forEach(f => io.error(`  - ${f}`));
    }
    io.error('\n✗ www 需要重新同步：node scripts/sync-www.mjs');
    return 1;
  }

  const files = sync(src, dest);
  io.log(`✓ 已同步 ${files.length} 个文件到 ${dest}`);

  // 白名单是个"人写的清单"，一定会漏。用 sw.js 反查一次，
  // 把"少打包一个文件"变成构建期失败——否则它会一路静默到用户手机上变成 404。
  const missA = missingAssets(src, dest);
  if (missA.length) {
    io.error('\n✗ 以下资源被 sw.js 要求缓存，却不在打包输出里（装到手机上会 404）：');
    missA.forEach(f => io.error(`  - ${f}`));
    io.error('  请把缺失的文件加入 sync-www.mjs 的 INCLUDE_FILES / INCLUDE_DIRS');
    return 1;
  }
  io.log(`  ✓ sw.js 要求的 ${swAssets(src).length} 个本地资源均已打包`);
  io.log('  下一步：npx cap sync');
  return 0;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  process.exit(runCli(process.argv.slice(2)));
}
