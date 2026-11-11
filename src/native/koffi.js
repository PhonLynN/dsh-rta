/**
 * native/koffi.js — 找到并加载 koffi（DSH 自带）。
 *
 * 为什么需要这一层：RTA 的抓屏、热键、光标全部走 Win32，而 Win32 调用需要 FFI。
 * DSH 桌面版把它自己的依赖放在 `resources/app.asar.unpacked/dsh/node_modules/`
 * （app.asar 内部解不出来），插件从自己的 node_modules 里 `import('koffi')` 是
 * 找不到的。所以依次尝试：
 *
 *   1. `import('koffi')`           —— 插件自己装了，最干净
 *   2. `DSH_KOFFI_PATH`            —— 显式覆盖（开发/调试）
 *   3. `process.resourcesPath` 下的 DSH 自带副本
 *   4. 从 DSH 可执行文件路径推断
 *   5. 常见安装位置（Windows 桌面版）
 *
 * 全部失败时返回 null 而不是抛错 —— 非 Windows、或精简版 DSH 里，
 * 插件仍应能加载并说清楚“这台机器没有抓屏能力”，而不是把 DSH 拖进启动失败。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);

/** koffi 的入口文件：包根目录下 index.cjs。 */
function entryOf(dir) {
  const p = join(dir, 'index.cjs');
  return existsSync(p) ? p : null;
}

/** 候选：包根目录列表（不是文件）。 */
export function koffiCandidates(env = process.env) {
  const out = [];
  const add = (dir) => { if (dir && typeof dir === 'string' && !out.includes(dir)) out.push(dir); };

  add(env.DSH_KOFFI_PATH ? (env.DSH_KOFFI_PATH.endsWith('.cjs') ? dirname(env.DSH_KOFFI_PATH) : env.DSH_KOFFI_PATH) : null);

  // Electron 主进程里 process.resourcesPath 就是安装目录下的 resources/
  if (process.resourcesPath) {
    add(join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
    add(join(process.resourcesPath, 'app', 'node_modules', 'koffi'));
  }
  // 从可执行文件推断：<install>/DeepSeek Harness.exe → <install>/resources/...
  const exe = process.execPath || '';
  if (exe) {
    const install = dirname(exe);
    add(join(install, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
  }
  // 桌面版默认安装位置（fallback，只在 Windows 上试）
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local) add(join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
  }
  return out;
}

let cached;

/**
 * 加载 koffi 模块（同步 require，DSH 插件 apply 期间就能用）。
 * @returns {{koffi: object, source: string} | {koffi: null, source: string, error: string}}
 */
export function loadKoffi(env = process.env) {
  if (cached) return cached;
  const errors = [];

  // 1. 正常解析（插件把 koffi 列为可选依赖时）
  try {
    const mod = require('koffi');
    if (mod && typeof mod.load === 'function') {
      cached = { koffi: mod, source: 'node_modules/koffi' };
      return cached;
    }
  } catch (e) {
    errors.push(`require('koffi'): ${e?.code || e?.message}`);
  }

  // 2-5. 找 DSH 自带副本
  for (const dir of koffiCandidates(env)) {
    const entry = entryOf(dir);
    if (!entry) continue;
    try {
      const mod = require(entry);
      if (mod && typeof mod.load === 'function') {
        cached = { koffi: mod, source: entry };
        return cached;
      }
    } catch (e) {
      errors.push(`${entry}: ${e?.message ?? e}`);
    }
  }

  cached = { koffi: null, source: 'not-found', error: errors.join(' | ') };
  return cached;
}
