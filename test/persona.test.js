/**
 * 人格选择与「旧字段兜底」的测试。
 *
 * 盯的是一个用户能直接看见的 bug：在面板上把人格换成大肥鱼，
 * 说话还是小栖那个味儿。原因是旧配置里的 `persona.text` 被无条件
 * 追加在提示词末尾——它离历史最近、权重最大，压过了刚选的人格。
 *
 * 跑法：node --test test/persona.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonas, legacyPersonaText, parsePersona } from '../src/personas.js';

const LEGACY = '你住在 QQ 里，是个话不多但有意思的人。回答简短口语化，通常两三句话。';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-persona-'));
  const p = createPersonas({ dataDir: dir });
  return { dir, p, done: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} } };
}

test('人格：seed 之后列表里有 default 和大肥鱼', () => {
  const { p, done } = fresh();
  try {
    const ids = p.list().map((x) => x.id);
    assert.ok(ids.includes('default'), `列表里要有 default：${ids}`);
    assert.ok(ids.includes('fatfish'), `列表里要有 fatfish：${ids}`);
  } finally {
    done();
  }
});

test('人格：换成 fatfish 之后 resolve 出来的是大肥鱼，不是小栖', () => {
  const { p, done } = fresh();
  try {
    const persona = p.resolve('', { current: 'fatfish', byChat: {} });
    assert.equal(persona.id, 'fatfish');
    assert.equal(persona.name, '大肥鱼');
    assert.match(persona.body, /大肥鱼/, '正文要是大肥鱼那份');
    assert.doesNotMatch(persona.body, /你住在 QQ 里/, '不该混进小栖的正文');
  } finally {
    done();
  }
});

test('人格：按群指定优先于全局当前', () => {
  const { p, done } = fresh();
  try {
    const cfg = { current: 'fatfish', byChat: { g1: 'teacher' } };
    assert.equal(p.resolve('g1', cfg).id, 'teacher');
    assert.equal(p.resolve('g2', cfg).id, 'fatfish');
  } finally {
    done();
  }
});

test('人格：指定的文件被删了要静默回退 default，不能让机器人失声', () => {
  const { p, done } = fresh();
  try {
    const persona = p.resolve('', { current: 'not-exist', byChat: {} });
    assert.equal(persona.id, 'default');
    assert.ok(persona.body.length > 0);
  } finally {
    done();
  }
});

/* ---------------- 旧字段 persona.text 的兜底规则 ---------------- */

test('旧字段：人格文件有正文时不拼（换人格才真的换）', () => {
  const { p, done } = fresh();
  try {
    const persona = p.resolve('', { current: 'fatfish', byChat: {} });
    assert.equal(legacyPersonaText(persona, LEGACY), '', '有正文就不该再挂旧 text');
  } finally {
    done();
  }
});

test('旧字段：default 人格也不拼（default.md 的正文就是它抄过去的，重复等于白吃 token）', () => {
  const { p, done } = fresh();
  try {
    const persona = p.resolve('', { current: 'default', byChat: {} });
    assert.ok(persona.body.includes('你住在 QQ 里'), '前提：default.md 正文确实含这段');
    assert.equal(legacyPersonaText(persona, LEGACY), '', '不能拼两遍');
  } finally {
    done();
  }
});

test('旧字段：default.md 被删了会被 seed 补回来，所以旧 text 实际上永远不会生效', () => {
  const { dir, p, done } = fresh();
  try {
    p.list();
    const f = join(dir, 'personas', 'default.md');
    assert.ok(existsSync(f));
    unlinkSync(f);
    /**
     * `resolve()` 里的 `seed()` 会把缺的人格文件重新写出来。
     * 也就是说 `persona.body` 在实际运行中不会为空——旧 text 那条兜底
     * 是纯安全网（目录只读、写盘失败时才轮到它），不是常规路径。
     * 这条断言就是把这个事实钉住，免得以后有人以为删了文件就会退回旧配置。
     */
    const persona = p.resolve('', { current: 'not-exist', byChat: {} });
    assert.ok(existsSync(f), 'seed 应该把 default.md 补回来');
    assert.ok(persona.body.length > 0);
    assert.equal(legacyPersonaText(persona, LEGACY), '', '有正文就不挂旧 text');
  } finally {
    done();
  }
});

test('旧字段：没有正文也没有旧 text 时返回空串（不要拼出 undefined）', () => {
  assert.equal(legacyPersonaText({ body: '' }, undefined), '');
  assert.equal(legacyPersonaText(null, null), '');
  assert.equal(legacyPersonaText({ body: '' }, '  补充说明  '), '补充说明', '要去掉首尾空白');
});

/* ---------------- 解析 ---------------- */

test('解析：`---` 头里的 name / tags 认得出', () => {
  const r = parsePersona('x', '---\nname: 测试人格\ntags: 甲, 乙\n---\n正文第一行');
  assert.equal(r.name, '测试人格');
  assert.deepEqual(r.tags, ['甲', '乙']);
  assert.equal(r.body, '正文第一行');
});

test('解析：没有头就整段当正文，名字退回 id', () => {
  const r = parsePersona('bare', '就是一段话');
  assert.equal(r.name, 'bare');
  assert.equal(r.body, '就是一段话');
});

/* ---------------- 人格搬成文件（0.10.7） ---------------- */

const ROOT = join(import.meta.dirname, '..');
const BUILTIN = join(ROOT, 'personas');

test('仓库：personas/ 里 8 份内置人格都在，且每份都有 name', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(BUILTIN).filter((n) => n.endsWith('.md')).sort();
  assert.equal(files.length, 8, `内置人格数量变了：${files}`);
  for (const f of files) {
    const p = parsePersona(f.slice(0, -3), readFileSync(join(BUILTIN, f), 'utf8'));
    assert.ok(p.body.length > 0, `${f} 没有正文`);
    assert.notEqual(p.name, f.slice(0, -3), `${f} 缺少 --- 头里的 name`);
  }
});

test('索引：personas/index.json 与文件逐份对得上（改了人格忘了重算索引会红）', () => {
  // 直接跑脚本的 --check，测的就是 CI 跑的那条路——自己再实现一遍比对
  // 等于把「两套规则迟早不一致」的问题又造一次。
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-persona-index.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `索引校验失败：${r.stderr || r.stdout}`);
});

test('seed：只补缺的，用户在数据目录改过的不会被覆盖', () => {
  const { dir, p, done } = fresh();
  try {
    p.list(); // 触发 seed
    const f = join(dir, 'personas', 'terse.md');
    const mine = '---\nname: 我改的\n---\n只剩一句。';
    writeFileSync(f, mine, 'utf8');
    p.seed(); // 再 seed 一次
    assert.equal(readFileSync(f, 'utf8'), mine, 'seed 不能覆盖用户改过的文件');
  } finally {
    done();
  }
});

test('seed：自带目录读不到时只记日志，不抛错（打包漏了 personas/ 也不能让插件起不来）', () => {
  const logs = [];
  const p = createPersonas({
    dataDir: mkdtempSync(join(tmpdir(), 'roost-persona-')),
    builtinDir: join(tmpdir(), 'roost-no-such-dir-' + Date.now()),
    log: (m) => logs.push(m),
  });
  try {
    assert.doesNotThrow(() => p.seed());
    assert.ok(logs.some((m) => m.includes('人格库目录读不到')), `日志里要有提示：${logs}`);
    assert.deepEqual(p.list(), [], '没有任何人格文件时列表为空');
  } finally {
    try { rmSync(p.builtinDir(), { recursive: true, force: true }); } catch {}
  }
});

