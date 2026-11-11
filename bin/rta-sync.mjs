#!/usr/bin/env node
/**
 * bin/rta-sync.mjs — 把 workspace 源码同步到本机已安装的插件目录。
 *
 * 为什么需要：plugin_manager 用 `file:` 安装时，pnpm 对目录做的是「安装时刻的
 * 硬链接快照」——运行中的 DSH 读的是 ~/.dsh/profiles/<profile>/node_modules/dsh-rta，
 * 不是这个工作区。改完 src/ 后必须同步过去，再在插件页禁用→启用一次，
 * 插件模块会被重新 import，新代码即生效（本轮实测，无需重启 DSH）。
 *
 * 用法：
 *   node bin/rta-sync.mjs            # 同步到默认 desktop profile
 *   node bin/rta-sync.mjs --profile=xxx
 *   RTA_PLUGIN_DIR="C:\...\dsh-rta" node bin/rta-sync.mjs
 */

import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['package.json', 'dsh.plugin.json', 'cordis.patch.yml', 'README.md', 'NOTICE', 'LICENSE'];
const COPY_DIRS = ['src', 'scripts', 'test', 'bin'];
// 只同步运行时需要的 UI 子目录；ui/floating-window 是设计原型（含 18MB 字体），不进插件包。
const COPY_SUBDIRS = ['ui/overlay'];
const SKIP_DIRS = new Set(['node_modules', '.git', '_probe', '.claude']);

function argValue(prefix) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function candidates() {
  const out = [];
  const explicit = process.env.RTA_PLUGIN_DIR || argValue('--dir=');
  if (explicit) out.push(resolve(explicit));
  const profile = argValue('--profile=') || process.env.DSH_PROFILE || 'desktop';
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  out.push(join(home, 'profiles', profile, 'node_modules', 'dsh-rta'));
  out.push(join(home, 'bundles', 'dsh-rta'));
  return out;
}

function findTarget() {
  for (const c of candidates()) {
    if (existsSync(join(c, 'package.json'))) return c;
  }
  return null;
}

function main() {
  const target = findTarget();
  if (!target) {
    console.error('[rta-sync] 找不到已安装的插件目录。先执行：');
    console.error('  plugin_manager install_bundle target=file:<this-workspace>');
    console.error('或显式指定：RTA_PLUGIN_DIR=<path> node bin/rta-sync.mjs');
    process.exit(2);
  }
  let copied = 0;
  for (const dir of COPY_DIRS) {
    const src = join(root, dir);
    if (!existsSync(src)) continue;
    const dst = join(target, dir);
    if (dir === 'src') {
      // src 整体替换：删旧目录避免残留过期模块
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true, filter: (p) => !SKIP_DIRS.has(p.split(/[\\/]/).pop()) });
    } else {
      cpSync(src, dst, {
        recursive: true,
        force: true,
        filter: (p) => !SKIP_DIRS.has(p.split(/[\\/]/).pop()),
      });
    }
    copied++;
  }
  for (const file of ROOT_FILES) {
    const src = join(root, file);
    const dst = join(target, file);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    // 注意：pnpm 的 file: 安装对这些根文件是**硬链接**，cpSync 会因同 inode 报错。
    // 内容相同就跳过；不同就直接写目标路径（硬链接会同步更新，内容一致所以安全）。
    const data = readFileSync(src);
    let same = false;
    try {
      same = existsSync(dst) && readFileSync(dst).equals(data);
    } catch { /* ignore */ }
    if (!same) writeFileSync(dst, data);
    copied++;
  }
  // 运行时 UI（Electron 浮窗）：复制到 <plugin>/ui/overlay
  for (const sub of COPY_SUBDIRS) {
    const src = join(root, sub);
    if (!existsSync(src)) continue;
    const dst = join(target, sub);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true, filter: (p) => !SKIP_DIRS.has(p.split(/[\\/]/).pop()) });
    copied++;
  }

  console.log(`[rta-sync] synced ${copied} path(s) -> ${target}`);
  console.log('[rta-sync] 下一步：插件页把 dsh-rta 禁用→启用一次（或用 plugin_manager set_bundle），让新模块生效。');
}

main();
