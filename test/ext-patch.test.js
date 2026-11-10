/**
 * 受管块同步（实施阶段 1.2 / 验收 8a、8c 前置）。
 *
 * 盯的是方案 L 的三条硬约束和一处最容易越界的地方：
 *  1. 受管块零 `!!js` / YAML tag / `${...}`，`env` 只有三个白名单键；
 *  2. `command` 永远指向宿主 launcher，扩展清单的 command/args 不许进来；
 *  3. 用户手写条目一条不动、幂等、默认不写盘（保守开关）；
 *  4. 受管块标记不成对时拒绝改文件，写完失败要能逐字节回滚。
 *
 * 跑法：node --test test/ext-patch.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  BLOCK_BEGIN,
  BLOCK_END,
  ALLOWED_ENV_KEYS,
  renderEntry,
  renderBlock,
  assertManagedShape,
  rejectExpressions,
  mergeManaged,
  createExtPatch,
  launcherPath,
} from '../src/ext-patch.js';

function tmpProfile(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-patch-'));
  // 同 test/mood.test.js：Windows 的 rmSync 偶发 ENOTEMPTY 不算测试失败。
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

const opts = { apiUrl: 'http://127.0.0.1:19731/v1', dir: 'C:/tmp/roost-data', roostDir: 'C:/tmp/roost' };

test('定稿形状：command 指向 launcher，env 只有三个引用名，零明文零表达式', () => {
  const block = renderBlock(['bili'], opts);
  assert.match(block, /command: node/);
  assert.match(block, /args: \['C:\/tmp\/roost\/src\/ext-launcher.mjs'\]/);
  assert.match(block, /ROOST_EXT_ID: 'bili'/);
  assert.match(block, /failOnStartupError: false/);
  assert.match(block, /serverName: bili/);
  for (const k of ALLOWED_ENV_KEYS) assert.ok(block.includes(`${k}:`), k);
  assert.equal(rejectExpressions(block).length, 0);
  assert.equal(/\$\{credential:/.test(block), false);
  assert.equal(/expandTemplates/.test(block), false);
  assert.equal(/ROOST_API_TOKEN/.test(block), false, '令牌绝不进受管块');
  assert.equal(/maxInstructionBytes/.test(block), false, '沿用官方默认 32768，不自定义');
  assert.match(launcherPath(), /ext-launcher\.mjs$/);
});

test('结构校验：拒绝 !!js / 模板插值 / tab / 非白名单 env 键 / 缺字段', () => {
  const good = renderBlock(['bili'], opts);
  assert.equal(assertManagedShape(good).ok, true);
  assert.deepEqual(assertManagedShape(good).ids, ['bili']);

  const bad = (s) => assertManagedShape(s).ok;
  assert.equal(bad(good.replace("command: node", "command: !!js process.env.CMD")), false);
  assert.equal(bad(good.replace("ROOST_API_URL: 'http://127.0.0.1:19731/v1'", "ROOST_API_URL: '${credential:REF}'")), false);
  assert.equal(bad(good.replace('        env:', '        env:\n          EVIL_TOKEN: x')), false);
  assert.equal(bad(good.replace(/^    /m, '\t')), false);
  assert.equal(bad(good.replace('        failOnStartupError: false\n', '')), false);
  assert.equal(rejectExpressions('a\n\t!!js x').length >= 2, true);
  // 单感叹号本地 tag、小写/带短横的 env 键也不能漏
  assert.equal(bad(good.replace('command: node', 'command: !js evil')), false);
  assert.equal(bad(good.replace('        env:', '        env:\n          token: x')), false);
  assert.equal(bad(good.replace('        env:', '        env:\n          bad-key: x')), false);
});

test('mergeManaged：用户手写条目一条不动，重复合并幂等', () => {
  const user = [
    '# 用户自己写的',
    '- insert:',
    '    - id: my-own',
    '      name: some-plugin',
    '',
  ].join('\n');
  const block = renderBlock(['bili'], opts);
  const once = mergeManaged(user, block);
  assert.match(once, /- id: my-own/);
  assert.match(once, /- id: mcp-bili/);
  assert.equal(once.indexOf('- id: my-own') < once.indexOf(BLOCK_BEGIN), true, '受管块追加在用户内容之后');

  const twice = mergeManaged(once, block);
  assert.equal(twice, once, '幂等');
  assert.equal((twice.match(/BLOCK|mcp-bili/g) || []).length, (once.match(/BLOCK|mcp-bili/g) || []).length);
});

test('标记不成对 / 顺序颠倒 / 重复：拒绝合并，不猜用户意图', () => {
  const block = renderBlock(['bili'], opts);
  assert.throws(() => mergeManaged(`${BLOCK_BEGIN}\n- insert:\n`, block), /不成对/);
  assert.throws(() => mergeManaged(`${BLOCK_END}\n${BLOCK_BEGIN}\n`, block), /不成对|重复|顺序颠倒/);
  // 用户在手写注释里抄了完整 BEGIN，indexOf 会错位，宁可拒绝改文件
  const copied = `# 备注：${BLOCK_BEGIN} 是标记\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\n`;
  assert.throws(() => mergeManaged(copied, block), /重复/);
});

test('保守开关：默认不写盘；apply:true 才写，且备份脱敏', (t) => {
  const profile = tmpProfile(t);
  const file = join(profile, 'cordis.patch.yml');
  fs.writeFileSync(file, '- insert:\n    - id: user-handwritten\n      name: x\n  # token: super-secret-value\n', 'utf8');
  const before = fs.readFileSync(file, 'utf8');

  const p = createExtPatch({ profileDir: profile, dir: opts.dir, apiUrl: opts.apiUrl, roostDir: opts.roostDir });
  const preview = p.render(['bili']);
  assert.equal(preview.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '默认绝不碰宿主 profile');
  assert.match(preview.text, /- id: mcp-bili/);

  const applied = p.render(['bili'], { apply: true });
  assert.equal(applied.written, true);
  assert.equal(applied.changed, true);
  assert.match(fs.readFileSync(file, 'utf8'), /- id: user-handwritten/);
  assert.match(fs.readFileSync(file, 'utf8'), /- id: mcp-bili/);
  assert.ok(applied.backup && fs.existsSync(applied.backup));
  assert.equal(/super-secret-value/.test(fs.readFileSync(applied.backup, 'utf8')), false, '备份不含明文');

  // 第二次：内容一致 → 不写盘、不再产生备份
  const again = p.render(['bili'], { apply: true });
  assert.equal(again.changed, false);
  assert.equal(again.written, false);
});

test('写入前原文保留在内存用于回滚：标记损坏时文件逐字节不变', (t) => {
  const profile = tmpProfile(t);
  const file = join(profile, 'cordis.patch.yml');
  const broken = `${BLOCK_BEGIN}\n- insert:\n`; // 只有起标记
  fs.writeFileSync(file, broken, 'utf8');
  const p = createExtPatch({ profileDir: profile, apiUrl: opts.apiUrl, dir: opts.dir, roostDir: opts.roostDir });
  assert.throws(() => p.render(['bili'], { apply: true }), /不成对/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('BEGIN 前的用户内容没换行时补分隔；合并失败不留半截备份', (t) => {
  const profile = tmpProfile(t);
  const file = join(profile, 'cordis.patch.yml');
  const original = `- insert:\n    - id: x\n      name: y${BLOCK_BEGIN}\nold\n${BLOCK_END}\n`;
  fs.writeFileSync(file, original, 'utf8');
  const block = renderBlock(['bili'], opts);
  const merged = mergeManaged(original, block);
  assert.equal(/name: y# >>>/.test(merged), false, '注释不能粘在 YAML 值后面');
  assert.match(merged, /name: y\n# >>>/);

  fs.writeFileSync(file, `${BLOCK_BEGIN}\n- insert:\n`, 'utf8');
  const p = createExtPatch({ profileDir: profile, apiUrl: opts.apiUrl, dir: opts.dir, roostDir: opts.roostDir });
  assert.throws(() => p.render(['bili'], { apply: true }), /不成对/);
  assert.equal(fs.readdirSync(profile).filter((f) => f.includes('roost-bak')).length, 0, '失败不落备份');
});

test('多扩展：按 id 排序生成，结构校验逐条覆盖', () => {
  const block = renderBlock(['bili', 'bili-helper', 'weather'], opts);
  const shape = assertManagedShape(block);
  assert.equal(shape.ok, true, shape.problems.join('；'));
  assert.deepEqual(shape.ids, ['bili', 'bili-helper', 'weather']);
  assert.equal(/ROOST_EXT_ID: 'other'/.test(block), false);
  assert.match(renderEntry('bili-helper', opts), /ROOST_EXT_ID: 'bili-helper'/);
});

/**
 * 端口必须在**渲染时**求值，不能创建时算死。
 *
 * 真机场景：`config.json` 写 17321，被占 → `createInboundServer()` 漂到 17322 上真听。
 * 若受管块仍写 17321，扩展连过去是 **connection refused**（不是 401）：
 * 不走鉴权、不记 `ext.auth_failed`、面板两个状态都不亮 —— 静默失联。
 */
test('运行期端口优先：getPort 变化后重新渲染的 URL 跟着变', (t) => {
  const profile = tmpProfile(t);
  let live = 0;
  const p = createExtPatch({
    profileDir: profile, dir: opts.dir, roostDir: opts.roostDir,
    port: 17321,
    getPort: () => live || undefined,
  });

  const before = p.render(['bili']);
  assert.ok(
    before.block.includes("ROOST_API_URL: 'http://127.0.0.1:17321/v1'"),
    `没 listen 时用配置端口，实际：${before.block.split('\n').find((l) => l.includes('ROOST_API_URL'))}`,
  );

  live = 17322; // 模拟真实端口漂移
  const after = p.render(['bili']);
  assert.ok(
    after.block.includes("ROOST_API_URL: 'http://127.0.0.1:17322/v1'"),
    `漂移后要用实际端口，实际：${after.block.split('\n').find((l) => l.includes('ROOST_API_URL'))}`,
  );
  assert.ok(!after.block.includes(':17321/'), '漂移后不能再残留旧端口');

  // 显式 apiUrl 优先级最高（测试与自定义部署要用）
  const forced = createExtPatch({
    profileDir: profile, dir: opts.dir, roostDir: opts.roostDir,
    apiUrl: 'http://127.0.0.1:19999/v1', getPort: () => 17322,
  });
  assert.match(forced.render(['bili']).block, /:19999\/v1/);
});

test('getPort 抛错时退回配置端口，不让安装因此失败', (t) => {
  const profile = tmpProfile(t);
  const p = createExtPatch({
    profileDir: profile, dir: opts.dir, roostDir: opts.roostDir,
    port: 17333,
    getPort: () => { throw new Error('server 还没建'); },
  });
  assert.match(p.render(['bili']).block, /:17333\/v1/);
});
