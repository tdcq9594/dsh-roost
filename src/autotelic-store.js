/**
 * 自驱模块的 JSON 读写适配——对齐 aurabot-beta `src/core/store.js` 的
 * readJson/writeJson 语义，供整文件移植的 feedback/skills 使用。
 *
 * 为什么单独一层：对方 feedback.js/skills.js 直接 import 它们的 core/store.js，
 * 我方没有同名模块。这里给出**语义等价**的两函数（BOM 处理 + 重试 + fallback；
 * tmp+rename 原子写），避免改移植文件的一行函数体。
 *
 * MIT License, Copyright (c) 2026 Aurabot contributors（语义来源）；
 * 本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 */

import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic.js';

const sleepSync = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 短自旋，对方 core/store.js 同款 */ }
};

/** 读 JSON：BOM 剥掉、空文件与瞬态错误重试 3 次，失败返回 fallback（函数则调用） */
export function readJson(file, fallback) {
  for (let i = 0; i < 3; i++) {
    try {
      let text = readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text.trim()) throw Object.assign(new Error(`文件是空的：${file}`), { code: 'EMPTYFILE' });
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      if (i < 2) sleepSync(40);
    }
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** 原子写 JSON：tmp + rename 语义，由 writeJsonAtomic 保证「宁可不写也不写坏」 */
export function writeJson(file, value) {
  writeJsonAtomic(file, value, { indent: 2 });
}

export { existsSync };
