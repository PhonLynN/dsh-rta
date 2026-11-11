#!/usr/bin/env node
/**
 * scripts/install-overlay.mjs — 安装 RTA 全局浮窗用的运行时。
 *
 * 两个独立运行时（都放用户目录，避免塞进 DSH profile 的 node_modules）：
 *   1) Electron 本体 → `~/.dsh/rta/overlay-runtime`（解包后 ~350MB）；
 *   2) 液态玻璃面板的原生模块 `@hicccc77/electron-liquid-glass` → `~/.dsh/rta/glass-runtime`
 *      （N-API 预编译 .node，无需 VS 工具链；靠 DXGI DDA + D3D11 提供「窗口背后真实模糊」）。
 *
 * 逻辑：
 *   1) 有 dist/electron.exe → 复用；没有 → 写只依赖 electron 的 package.json 后 npm install；
 *   2) npm 的 postinstall 没下二进制 → 手动跑 electron/install.js；
 *   3) 玻璃运行时：没有 node_modules/@hicccc77/electron-liquid-glass → npm install 到 glass-runtime。
 *
 * 用法：
 *   node scripts/install-overlay.mjs
 *   node scripts/install-overlay.mjs --version=33.4.11 --force
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const ELECTRON_VERSION = (process.argv.slice(2).find((a) => a.startsWith('--version=')) || '--version=33.4.11').split('=')[1];
const GLASS_VERSION = '0.4.0';
const FORCE = process.argv.includes('--force');

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const runtimeDir = join(home, 'rta', 'overlay-runtime');
const electronDist = join(runtimeDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const installScript = join(runtimeDir, 'node_modules', 'electron', 'install.js');

const glassDir = join(home, 'rta', 'glass-runtime');
const glassModule = join(glassDir, 'node_modules', '@hicccc77', 'electron-liquid-glass');

function log(msg) { console.log(`[rta-overlay] ${msg}`); }

function run(cmd, args, cwd = runtimeDir, extraEnv = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_MIRROR: MIRROR, ...extraEnv },
  });
  return result.status ?? 1;
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// ---- 1) 液态玻璃运行时（可选：装不上就回退渲染层采集方案，不影响浮窗可用）----
if (!existsSync(glassModule) || FORCE) {
  mkdirSync(glassDir, { recursive: true });
  writeFileSync(
    join(glassDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-rta-glass-runtime',
      version: '0.1.0',
      private: true,
      description: 'RTA 浮窗的液态玻璃面板运行时（@hicccc77/electron-liquid-glass 原生模块）',
      dependencies: { '@hicccc77/electron-liquid-glass': GLASS_VERSION },
    }, null, 2)}\n`,
  );
  log(`installing @hicccc77/electron-liquid-glass@${GLASS_VERSION} into ${glassDir}`);
  const glassStatus = run(npmBin(), ['install', '--no-audit', '--no-fund', '--loglevel=error'], glassDir);
  if (glassStatus !== 0 || !existsSync(glassModule)) {
    log('liquid glass runtime install failed — overlay will fall back to renderer capture (RTA_GLASS=0)');
  } else {
    log(`ok: ${glassModule}`);
  }
} else {
  log(`liquid glass runtime already installed: ${glassModule}`);
}

// ---- 2) Electron 本体 ----
if (existsSync(electronDist) && !FORCE) {
  log(`electron runtime already installed: ${electronDist}`);
  process.exit(0);
}

mkdirSync(runtimeDir, { recursive: true });
writeFileSync(
  join(runtimeDir, 'package.json'),
  `${JSON.stringify({
    name: 'dsh-rta-overlay-runtime',
    version: '0.1.0',
    private: true,
    description: 'RTA 全局浮窗的 Electron 运行时（独立于 DSH profile）',
    dependencies: { electron: ELECTRON_VERSION },
  }, null, 2)}\n`,
);

log(`installing electron@${ELECTRON_VERSION} into ${runtimeDir}`);
let status = run(npmBin(), ['install', '--no-audit', '--no-fund', '--loglevel=error']);
if (status !== 0) {
  log('npm install failed; retrying with --ignore-scripts=false');
  status = run(npmBin(), ['install', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts=false']);
}

// npm 的 electron postinstall 在部分环境里不会执行，导致只有 JS 包没有 dist。
if (!existsSync(electronDist) && existsSync(installScript)) {
  log('electron binary missing after npm install; running electron/install.js');
  status = run(process.execPath, [installScript]);
}

if (!existsSync(electronDist)) {
  console.error(`[rta-overlay] 安装失败：找不到 ${electronDist}`);
  console.error('[rta-overlay] 排查：网络 / npm 代理 / ELECTRON_MIRROR；也可手动下载后把路径设到 DSH_RTA_ELECTRON。');
  process.exit(status || 2);
}

log(`ok: ${electronDist}`);
