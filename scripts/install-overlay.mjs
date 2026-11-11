#!/usr/bin/env node
/**
 * scripts/install-overlay.mjs — 安装 RTA 全局浮窗用的 Electron 运行时。
 *
 * 为什么放用户目录：Electron 解包后 ~350MB，塞进 DSH profile 的 node_modules
 * 会让插件安装/同步变得极慢；运行时跟插件代码是解耦的，放 `~/.dsh/rta/overlay-runtime`
 * 更合适（`DSH_HOME` 可覆盖根目录）。
 *
 * 逻辑：
 *   1) 已经有 dist/electron.exe → 直接复用；
 *   2) 没有 → 写一个只依赖 electron 的 package.json，npm install（走 npmmirror 镜像）；
 *   3) npm 的 postinstall 没下二进制（某些 npm 配置下会发生）→ 手动跑 electron/install.js。
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
const FORCE = process.argv.includes('--force');

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const runtimeDir = join(home, 'rta', 'overlay-runtime');
const electronDist = join(runtimeDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const installScript = join(runtimeDir, 'node_modules', 'electron', 'install.js');

function log(msg) { console.log(`[rta-overlay] ${msg}`); }

function run(cmd, args, extraEnv = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_MIRROR: MIRROR, ...extraEnv },
  });
  return result.status ?? 1;
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

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
