#!/usr/bin/env node
/**
 * 生成 / 校验扩展文档。
 *
 *   node scripts/build-ext-docs.mjs           # 写 docs/API.md 与 docs/extension.d.ts
 *   node scripts/build-ext-docs.mjs --check   # 只比对，不一致退出 1（CI 用）
 */
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDocs, writeDocs } from '../src/ext-docs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const checkOnly = process.argv.includes('--check');

const version = (() => {
  try { return JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? ''; }
  catch { return ''; }
})();

if (checkOnly) {
  const bad = checkDocs({ docsDir: DOCS, version });
  if (bad.length) {
    console.error(`文档与源码不一致：${bad.join('、')}`);
    console.error('跑 node scripts/build-ext-docs.mjs 重新生成。');
    process.exit(1);
  }
  console.log('✓ 扩展文档一致');
  process.exit(0);
}

const files = writeDocs({ docsDir: DOCS, version });
for (const f of files) console.log(`已写入 ${f}`);
