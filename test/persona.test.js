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
import { mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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

test('旧字段：内置人格删掉后不再自动复活（seed 只跑一次），旧 text 兜底这才真正生效', () => {
  const { dir, p, done } = fresh();
  try {
    p.list(); // 触发 seed
    const f = join(dir, 'personas', 'default.md');
    assert.ok(existsSync(f));
    unlinkSync(f);
    /**
     * 0.11 起 `seed()` 一个进程只跑一次，`list/read/resolve` 不会再补文件。
     *
     * 这是**故意改的行为**：以前删完下一次 `list()` 就把它拷回来，
     * 等于「内置人格其实删不掉」。现在文件真的没了，正文读不出来，
     * `legacyPersonaText` 这条兜底才第一次真正生效。
     */
    const persona = p.resolve('', { current: 'not-exist', byChat: {} });
    assert.equal(existsSync(f), false, 'seed 只跑一次，不该再把文件补回来');
    assert.equal(persona.body, '', '正文读不出来，body 为空');
    assert.equal(legacyPersonaText(persona, LEGACY), LEGACY, '这时才轮到旧 text 兜底');
  } finally {
    done();
  }
});

test('删除：备份失败就不许删（捞不回来等于把承诺作废）', () => {
  const { dir, p, done } = fresh();
  try {
    p.list(); // seed
    // 把 .backup 占成一个普通文件，备份时 mkdir 会失败
    writeFileSync(join(dir, 'personas', '.backup'), 'x', 'utf8');
    assert.throws(() => p.remove('fatfish'), /备份失败/);
    assert.ok(existsSync(join(dir, 'personas', 'fatfish.md')), '备份没成，文件必须还在');
  } finally {
    done();
  }
});

test('保存：覆盖旧人格也会先备份（注释说共用一条规则，就得真共用）', () => {
  const { dir, p, done } = fresh();
  try {
    p.list();
    p.save('fatfish', '---\nname: 大肥鱼\n---\n第一版。');
    p.save('fatfish', '---\nname: 大肥鱼\n---\n第二版。');
    /**
     * 备份目录名只精确到秒，两次保存跨过整秒就会分成两个目录——
     * 所以不能断言「只有一个目录」，只能断言「第一版确实被备份下来了」。
     */
    const base = join(dir, 'personas', '.backup');
    const texts = readdirSync(base)
      .flatMap((d) => readdirSync(join(base, d)).map((f) => readFileSync(join(base, d, f), 'utf8')));
    assert.ok(texts.some((t) => /第一版/.test(t)), `第二版写入前应把第一版备份下来：${texts.length} 份备份`);
  } finally {
    done();
  }
});

test('删除：内置人格删掉后，换个进程也不再复活（墓碑）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-persona-'));
  try {
    const p1 = createPersonas({ dataDir: dir });
    p1.list(); // seed
    p1.remove('fatfish');
    assert.equal(existsSync(join(dir, 'personas', 'fatfish.md')), false);

    // 模拟重启：新实例会重新 seed 一遍，但墓碑要挡住它
    const p2 = createPersonas({ dataDir: dir });
    const ids = p2.list().map((x) => x.id);
    assert.ok(!ids.includes('fatfish'), `墓碑没生效，fatfish 又回来了：${ids}`);
    assert.ok(ids.includes('default'), '其它内置人格照常在');

    // 用户又手动写了同名人格 → 墓碑摘掉，正常保存
    p2.save('fatfish', '---\nname: 我又想要了\n---\n正文。');
    const p3 = createPersonas({ dataDir: dir });
    assert.ok(p3.list().some((x) => x.id === 'fatfish'), 'save 之后墓碑要清掉');
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
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

/* ---------------- 人格级工具限制（P1） ---------------- */

test('解析：tools 三元语义——省略/null 不限制、[] 或空值全禁、[a,b] 只给这些', () => {
  const none = parsePersona('x', '---\nname: 甲\n---\n正文');
  assert.equal(none.tools, null, '没写就是 null（不限制，保持旧行为）');

  const nul = parsePersona('x', '---\nname: 甲\ntools: null\n---\n正文');
  assert.equal(nul.tools, null);

  const empty = parsePersona('x', '---\nname: 甲\ntools: []\n---\n正文');
  assert.deepEqual(empty.tools, []);

  const blank = parsePersona('x', '---\nname: 甲\ntools:\n---\n正文');
  assert.deepEqual(blank.tools, [], '写了 key 没写值按全禁（fail-closed），要全开请写 null');

  const two = parsePersona('x', '---\nname: 甲\ntools: qq_send, memory_search\n---\n正文');
  assert.deepEqual(two.tools, ['qq_send', 'memory_search']);

  const bracket = parsePersona('x', '---\nname: 甲\ntools: [qq_send]\n---\n正文');
  assert.deepEqual(bracket.tools, ['qq_send'], '中括号写法也认');
});

test('解析：tools 容忍引号和行尾注释（写得很自然，不该静默错位）', () => {
  const quoted = parsePersona('x', '---\nname: 甲\ntools: "qq_send"\n---\n正文');
  assert.deepEqual(quoted.tools, ['qq_send'], '引号要剥掉，否则永远匹配不上');

  const comment = parsePersona('x', '---\nname: 甲\ntools: [qq_send] # 只给聊天\n---\n正文');
  assert.deepEqual(comment.tools, ['qq_send'], '# 后面的注释要截掉');

  const emptyComment = parsePersona('x', '---\nname: 甲\ntools: [] # 全禁\n---\n正文');
  assert.deepEqual(emptyComment.tools, []);
});

test('解析：头部前面多空行、分隔符带尾随空格也认（否则 tools 会被当成正文）', () => {
  const r = parsePersona('x', '\n\n--- \nname: 甲\ntools: []\n--- \n正文');
  assert.deepEqual(r.tools, [], '头没认出来的话这里会是 null，限制静默失效');
  assert.equal(r.name, '甲');
  assert.equal(r.body, '正文');
});

/* ---------------- 人格搬成文件（0.10.7） ---------------- */

const ROOT = join(import.meta.dirname, '..');
const BUILTIN = join(ROOT, 'personas');

test('仓库：personas/ 里 8 份内置人格都在，且每份都有 name', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(BUILTIN).filter((n) => n.endsWith('.md')).sort();
  /**
   * 用 `>=` 而不是 `===`：以后往仓库里加人格不该把这条测试弄红。
   * 「索引和文件是否一致」由下一条（跑 `--check`）负责，那才是真正的守卫。
   */
  assert.ok(files.length >= 8, `内置人格少了：${files}`);
  for (const must of ['default.md', 'fatfish.md']) assert.ok(files.includes(must), `缺 ${must}`);
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


test('解析：空头 `---\\n---` 也认（认不出就会让 tools 静默变 null）', () => {
  const r = parsePersona('x', '---\n---\n正文');
  assert.equal(r.name, 'x');
  assert.equal(r.body, '正文');
});

test('解析：键名容忍缩进和大小写（认不出会让 tools 静默变全开）', () => {
  assert.deepEqual(parsePersona('x', '---\n  tools: []\n---\n正文').tools, []);
  assert.deepEqual(parsePersona('x', '---\nTools: []\n---\n正文').tools, []);
});
