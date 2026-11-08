#!/usr/bin/env node
/**
 * 一键备份 CLI（E4）
 *
 *   node scripts/backup.mjs export [--data <数据目录>] [--out <导出目录>]
 *   node scripts/backup.mjs import <备份.zip> [--data <数据目录>]
 *   node scripts/backup.mjs list   [--data <数据目录>]
 *   node scripts/backup.mjs cancel [--data <数据目录>]
 *
 * `--data` 不填就走 `src/config.js` 的 `dataDir()`（默认 ~/.dsh/dsh-roost，
 * 可用 DSH_ROOST_DATA 覆盖）。**import 只把文件解到 .restore/**，不碰现在
 * 正在用的数据；下次启动 dsh-roost 时、读配置之前才换上去，被换掉的旧文件
 * 会留在 backups/pre-restore-<时间戳>/ 里。
 *
 * 想在运行中的 DSH 上导出也不用停机：SQLite 走 `VACUUM INTO` 一致性快照。
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { dataDir } from '../src/config.js';
import {
  applyPendingRestore, cancelRestore, createBackup, listBackups,
  pendingRestore, stageRestore,
} from '../src/backup.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || '';

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const root = resolve(flag('data') || dataDir());

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '';
  } catch { return ''; }
}

function fail(e) {
  console.error(`✗ ${e?.message ?? e}`);
  process.exitCode = 1;
}

try {
  if (cmd === 'export') {
    const out = flag('out') ? resolve(flag('out')) : undefined;
    const r = createBackup({ root, out, version: version(), log: (m) => console.log(`  ${m}`) });
    console.log(`✓ 备份已生成：${r.file}`);
    console.log(`  ${r.files} 个文件 / ${(r.bytes / 1024 / 1024).toFixed(2)} MB${r.snapshots.length ? ` · SQLite 一致性快照 ${r.snapshots.length} 个` : ''}`);
    console.log('  换电脑后：node scripts/backup.mjs import <这个 zip>，然后重启 DSH。');
  } else if (cmd === 'import') {
    const zip = argv[1];
    if (!zip) throw new Error('用法：import <备份.zip>');
    const r = stageRestore({ zip: resolve(zip), root });
    console.log(`✓ 已校验 ${r.files} 个文件，暂存到 ${resolve(root, '.restore')}`);
    console.log(`  备份时间：${r.info.createdAt || '未知'} · 现有数据一个字节都没动。`);
    console.log('  **重启 DSH 后生效**（启动时读配置之前才换上），旧文件留在 backups/pre-restore-*/。');
    console.log('  反悔：node scripts/backup.mjs cancel');
  } else if (cmd === 'list') {
    const items = listBackups(root).filter((x) => x.kind !== 'pre-restore');
    if (!items.length) console.log('（还没有备份）');
    for (const it of items) {
      console.log(`${new Date(it.at).toLocaleString('zh-CN')}  ${it.kind === 'full' ? '完整包' : '记忆淡出备份'}  ${(it.bytes / 1024).toFixed(1)} KB  ${it.name}`);
    }
    const p = pendingRestore(root);
    if (p) console.log(`\n⚠ 有一份恢复等着下次启动生效（${p.files} 个文件，${p.createdAt || ''}）。`);
  } else if (cmd === 'cancel') {
    const p = pendingRestore(root);
    cancelRestore(root);
    console.log(p ? '✓ 已取消待生效的恢复，现有数据没动。' : '（没有待生效的恢复）');
  } else if (cmd === 'apply') {
    /** 仅供离线维护/测试用；正常路径是 DSH 启动时自动调用 */
    const r = applyPendingRestore({ root });
    console.log(r.applied ? `✓ 换上 ${r.applied} 个文件${r.kept ? `，旧文件在 ${r.kept}` : ''}` : '（没有待生效的恢复）');
  } else {
    console.log(`用法：
  node scripts/backup.mjs export [--data <dir>] [--out <dir>]   导出 zip
  node scripts/backup.mjs import <zip> [--data <dir>]           校验并暂存（重启才生效）
  node scripts/backup.mjs list   [--data <dir>]                 列出备份
  node scripts/backup.mjs cancel [--data <dir>]                 取消待生效的恢复
  node scripts/backup.mjs apply  [--data <dir>]                 离线维护用，立即应用`);
  }
} catch (e) {
  fail(e);
}
