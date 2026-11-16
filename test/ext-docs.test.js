/**
 * 扩展文档（`docs/API.md` / `docs/extension.d.ts`）的守卫。
 *
 * `scripts/build-ext-docs.mjs --check` 已经在 CI 里守「生成物没漂移」，但那条
 * 命令只在 CI 跑，本地改完忘跑就会把旧文档提交上去。这里把它变成测试，
 * 顺手补一条 `--check` 管不到的事：
 *
 *   **端点表的竖线数量**。ROUTE_NOTES 里写一个 `|`（比如
 *   `?scope=global|chat|both`），GFM 会把它当成单元格分隔符，那一行会渲染
 *   成两半——`--check` 完全不报，因为生成物确实「和源码一致」，只是渲染坏了。
 *
 * 跑法：node --test test/ext-docs.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderApiMd, API_DOC } from '../src/ext-docs.js';
import { V1_ROUTES, V1_SCOPES, V1_IMPLEMENTED_HOOKS } from '../src/api-v1.js';

const doc = () => readFileSync(new URL(`../docs/${API_DOC}`, import.meta.url), 'utf8');
/** 生成脚本会把 package.json 的版本写进文档头部，比对时必须带上同一个值 */
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('D1 文档与源码一致（改端点/scope 后要重跑 build-ext-docs）', () => {
  assert.equal(doc(), renderApiMd({ version: VERSION }), 'docs/API.md 与源码生成结果不一致');
});

test('D2 端点表每行的竖线数一致（`|` 会把表格撑破）', () => {
  const bad = [];
  for (const [i, line] of doc().split('\n').entries()) {
    if (!/^\| (GET|POST) \|/.test(line)) continue;
    const n = (line.match(/\|/g) || []).length;
    if (n !== 6) bad.push(`第 ${i + 1} 行有 ${n} 条竖线：${line.slice(0, 100)}`);
  }
  assert.deepEqual(bad, [], 'ROUTE_NOTES 里出现了未转义的 `|`');
});

test('D3 路由表里每一条都出现在文档里，scope 也全部列出', () => {
  const text = doc();
  for (const key of Object.keys(V1_ROUTES)) {
    const [method, path] = key.split(' ');
    assert.ok(
      text.includes(`| ${method} | \`${path}\` |`),
      `文档里缺 ${key}`,
    );
  }
  for (const s of V1_SCOPES) {
    assert.ok(text.includes(`\`${s}\``), `文档的 scope 清单里缺 ${s}`);
  }
});

test('D4 「还有几条没接线」说的是真话，不是写死的旧数字', () => {
  const text = doc();
  const pending = Object.keys(V1_ROUTES).filter((k) => {
    const h = V1_ROUTES[k].hook;
    return h && !V1_IMPLEMENTED_HOOKS.includes(h);
  });

  /** 状态列与真实接线情况一致：⛔ 的条数必须等于未接线数 */
  const stalled = text.split('\n').filter((l) => /^\| (GET|POST) \|/.test(l) && l.includes('⛔'));
  assert.equal(stalled.length, pending.length, '端点表里 ⛔ 的条数与 V1_IMPLEMENTED_HOOKS 对不上');

  if (pending.length) {
    assert.ok(text.includes(`当前还有 ${pending.length} 条`), `文档没写清「还有 ${pending.length} 条未接线」`);
  } else {
    /** 全接线了就别再留「当前有若干条」这种过期话 */
    assert.ok(text.includes('当前 0 条'), '未接线已清零，501 说明里还留着旧数字');
    assert.ok(text.includes('当前一条都没有'), '未接线已清零，状态列说明里还留着旧话');
    assert.equal(stalled.length, 0, '未接线已清零，端点表里还有 ⛔');
  }
});
