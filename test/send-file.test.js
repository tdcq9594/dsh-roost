// 发文件的路径判断（`src/send-file.js`）。
//
// 这段逻辑错了只有两种表现，而且都必须靠人肉试才发现：
//   · 「该发的发不出去」——用户看到的是「她不肯给我文件」；
//   · 「不该发的发出去了」——**发出去就收不回来**。
// 所以断言全盯在边界上：放行要真的放行，拒绝要真的拒绝。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pathAllowed, isWithinRoot, realishPath } from '../src/send-file.js';

/** 每个用例一个干净的临时目录 */
function freshDir() {
  return mkdtempSync(join(tmpdir(), 'roost-send-file-'));
}

/** 造一个真文件（`statSync` 之后还要能读到，不能只造路径） */
function touch(p, body = 'x') {
  writeFileSync(p, body, 'utf8');
  return p;
}

/* ---------------- 默认不限制 ---------------- */

/**
 * `restrictPaths: false`（默认值）时**任何路径都放行**，包括不存在的。
 *
 * 不存在的文件不该在这一层被拦：那由调用方按 `missing` 报，
 * 报成「路径不允许」会把排查方向带偏（看起来像权限问题，其实是路径写错）。
 */
test('默认配置：任意路径都放行，包括不存在的', () => {
  const d = freshDir();
  const existing = touch(join(d, 'a.txt'));
  for (const p of [existing, join(d, '不存在的.docx'), join(d, '..', '别的目录', 'x.zip')]) {
    const r = pathAllowed(p);
    assert.deepEqual(r, { ok: true }, `${p} 该放行`);
  }
});

test('默认配置：给了 roots 也不看（限制是 restrictPaths 说了算）', () => {
  const d = freshDir();
  const root = join(d, 'root');
  mkdirSync(root);
  const outside = touch(join(d, 'outside.txt'));
  assert.deepEqual(pathAllowed(outside, { restrictPaths: false, roots: [root] }), { ok: true });
});

/* ---------------- 打开限制 ---------------- */

test('限制模式：roots 里的放行，roots 外的拒绝', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  const inside = touch(join(root, 'report.docx'));
  const outside = touch(join(d, 'secret.txt'));

  assert.deepEqual(pathAllowed(inside, { restrictPaths: true, roots: [root] }), { ok: true });

  const r = pathAllowed(outside, { restrictPaths: true, roots: [root] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'denied');
});

test('限制模式：extraRoots 里的也放行（两个内置根之外）', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  const extra = join(d, '项目');
  mkdirSync(root);
  mkdirSync(extra);
  const f = touch(join(extra, '报价单.xlsx'));

  assert.deepEqual(pathAllowed(f, { restrictPaths: true, roots: [root] }), {
    ok: false, reason: 'denied', message: `这个路径不在允许发送的目录内：${f}`,
  });
  assert.deepEqual(pathAllowed(f, { restrictPaths: true, roots: [root], extraRoots: [extra] }), { ok: true });
});

test('限制模式：多个 root 里命中任意一个就算过', () => {
  const d = freshDir();
  const a = join(d, 'a');
  const b = join(d, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const f = touch(join(b, 'x.pdf'));
  assert.deepEqual(pathAllowed(f, { restrictPaths: true, roots: [a, b] }), { ok: true });
});

/**
 * **文件不存在 ≠ 越权。**
 *
 * 这是最容易写反的一条：先 `realpathSync` 文件、失败就返回「不允许」，
 * 于是「路径写错了」会被报成「你没权限」——用户和模型会去改配置，
 * 而真正该做的是把路径改对。
 */
test('限制模式：文件不存在但路径在 root 内 → 放行（交给调用方报 missing）', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  const ghost = join(root, '还没生成.docx');
  assert.deepEqual(pathAllowed(ghost, { restrictPaths: true, roots: [root] }), { ok: true });
});

/**
 * root 不存在时**一个都别放行**。
 *
 * 反过来的写法（root 解析不了就跳过这条白名单）等于：把 root 删掉，
 * 白名单自动失效、全盘放开。配置写错一个字母就变成没有任何限制。
 */
test('限制模式：root 不存在时拒绝（无效的根不能放行任何东西）', () => {
  const d = freshDir();
  const ghostRoot = join(d, 'workspace');
  const f = touch(join(d, 'a.txt'));
  const r = pathAllowed(f, { restrictPaths: true, roots: [ghostRoot] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'denied');
});

test('限制模式：一个 root 都没有时全拒（fail-closed）', () => {
  const d = freshDir();
  const f = touch(join(d, 'a.txt'));
  assert.equal(pathAllowed(f, { restrictPaths: true }).ok, false);
  assert.equal(pathAllowed(f, { restrictPaths: true, roots: [], extraRoots: [] }).ok, false);
});

/**
 * `..` 逃逸必须拒绝。
 *
 * `resolve()` 会先把 `..` 词法归一，所以 `root/../secret` 变成 `parent/secret`，
 * 比对时自然落在 root 外面——但这条只有在**真的比对过**之后才成立，
 * 光判 `startsWith(root)` 字符串前缀就会放过去（`root` 是 `root2` 的前缀那种错法同理）。
 */
test('限制模式：`..` 逃逸拒绝（同级目录、上级目录都要拦）', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  const sibling = touch(join(d, 'secret.txt'));
  const up = touch(join(d, '..', `roost-escape-${process.pid}.txt`));

  for (const p of [join(root, '..', 'secret.txt'), `${root}/../secret.txt`, join(root, '..', '..', 'x.txt')]) {
    const r = pathAllowed(p, { restrictPaths: true, roots: [root] });
    assert.equal(r.ok, false, `${p} 不该放行`);
    assert.equal(r.reason, 'denied');
  }
  // 造出来的两个文件确实存在，证明上面拒的不是「因为不存在」
  assert.deepEqual(pathAllowed(sibling, { restrictPaths: true, roots: [root] }), {
    ok: false, reason: 'denied', message: `这个路径不在允许发送的目录内：${sibling}`,
  });
  assert.equal(pathAllowed(up, { restrictPaths: true, roots: [root] }).ok, false);
});

/**
 * root **内部**名字以 `..` 开头的子目录，不该被当成逃逸。
 *
 * `relative()` 对这种目录返回 `..资料\a.txt`。旧的判据是
 * `!rel.startsWith('..')` —— 于是它被当成越权拒掉了。
 * 现在 `src/send-file.js` 的判据收紧成 `rel !== '..' && !rel.startsWith('..' + sep)`，
 * 这条从 `todo` 转成了正式用例。
 *
 * 为什么留着它：`startsWith('..')` 是个**看起来对、边界错**的写法，
 * 以后有人「顺手简化」回去时，这条会立刻红。
 */
test('限制模式：root 里名叫 `..x` 的子目录不该被当成逃逸', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  const odd = join(root, '..资料');
  mkdirSync(odd);
  const f = touch(join(odd, 'a.txt'));
  assert.deepEqual(pathAllowed(f, { restrictPaths: true, roots: [root] }), { ok: true });
});

/* ---------------- isWithinRoot / realishPath 本身 ---------------- */

test('isWithinRoot：root 自己算在内', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  assert.equal(isWithinRoot(root, root), true);
});

test('isWithinRoot：前缀相同的兄弟目录不算在内', () => {
  const d = freshDir();
  const root = join(d, 'work');
  const sibling = join(d, 'work2');
  mkdirSync(root);
  mkdirSync(sibling);
  const f = touch(join(sibling, 'a.txt'));
  assert.equal(isWithinRoot(f, root), false);
});

test('isWithinRoot：不存在的尾部按词法拼接（不抛错）', () => {
  const d = freshDir();
  const root = join(d, 'workspace');
  mkdirSync(root);
  assert.equal(isWithinRoot(join(root, 'a', 'b', 'c.txt'), root), true);
});

test('realishPath：绝对路径原样返回（存在的走 realpath，形状不变）', () => {
  const d = freshDir();
  const f = touch(join(d, 'a.txt'));
  const r = realishPath(f);
  assert.equal(typeof r, 'string');
  assert.ok(r.endsWith('a.txt'), `${r} 不等于 ${f} 时至少尾名要对`);
});

test('realishPath：相对路径先按 cwd 归一（不能拿相对路径去比前缀）', () => {
  const r = realishPath('a.txt');
  assert.ok(r.includes('a.txt'));
  assert.ok(r.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(r), `${r} 应该是绝对路径`);
});
