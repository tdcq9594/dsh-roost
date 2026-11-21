// 原子写：内容正确、不留 tmp、并发不互盖。
//
// 最后一条是关键：固定 `${file}.tmp` 只防「断电留半个文件」，**不防两个写者
// 互盖**——两个写者写同一个 tmp，后一个顶掉前一个，先完成的那次 rename 就把
// 别人的内容扶正了，后完成的那次直接 ENOENT 抛错。随机 tmp 名之后两边都能成。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic, writeJsonAtomic } from '../src/atomic.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ATOMIC = join(HERE, '..', 'src', 'atomic.js');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'roost-atomic-'));
}

test('原子写：内容逐字节一致，写完目录里不留 tmp', () => {
  const dir = tmpDir();
  const f = join(dir, 'a.json');
  writeFileAtomic(f, '{"a":1}\n');
  assert.equal(readFileSync(f, 'utf8'), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir), ['a.json'], 'tmp 必须已经 rename 掉');
});

test('原子写：父目录不存在时自动建（多层也建）', () => {
  const dir = tmpDir();
  const f = join(dir, 'x', 'y', 'z.json');
  writeFileAtomic(f, 'ok');
  assert.equal(readFileSync(f, 'utf8'), 'ok');
});

test('原子写：写失败时清掉 tmp，不把半成品留在目录里', () => {
  const dir = tmpDir();
  /** 目标是已存在的**目录**：rename 到它上面必然失败 */
  const target = join(dir, 'busy');
  mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, 'x'));
  assert.deepEqual(readdirSync(dir), ['busy'], '失败后不许留 *.tmp');
});

test('原子写：覆盖已有文件是整体替换，不是就地改写', () => {
  const dir = tmpDir();
  const f = join(dir, 'b.txt');
  writeFileAtomic(f, 'a'.repeat(1000));
  const ino1 = statSync(f).ino;
  writeFileAtomic(f, 'b');
  assert.equal(readFileSync(f, 'utf8'), 'b');
  /** rename 换的是 inode；就地改写的话 inode 不变 */
  if (process.platform !== 'win32') assert.notEqual(statSync(f).ino, ino1);
});

test('原子写：mode 生效（POSIX；Windows 忽略不算错）', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const f = join(dir, 'secret.json');
  writeFileAtomic(f, '{}', { mode: 0o600 });
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('原子写 JSON：默认两空格缩进、不带结尾换行', () => {
  const dir = tmpDir();
  const f = join(dir, 'c.json');
  writeJsonAtomic(f, { a: 1, b: [2] });
  assert.equal(readFileSync(f, 'utf8'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
});

test('原子写 JSON：newline 与 indent 可调（迁就仓里两种既有格式）', () => {
  const dir = tmpDir();
  const f = join(dir, 'd.json');
  writeJsonAtomic(f, { a: 1 }, { newline: true });
  assert.equal(readFileSync(f, 'utf8'), '{\n  "a": 1\n}\n');
  writeJsonAtomic(f, [1, 2], { indent: 0 });
  assert.equal(readFileSync(f, 'utf8'), '[1,2]', 'indent 0 = 紧凑，和 JSON.stringify(x) 一致');
});

test('原子写 JSON：不可序列化的值要抛错，不能静默写出 "undefined"', () => {
  const dir = tmpDir();
  const f = join(dir, 'e.json');
  writeFileSync(f, '{"old":1}', 'utf8');
  /**
   * `JSON.stringify(undefined)` 返回 `undefined`，拼上换行就成了字符串
   * `"undefined"` —— 一个能写进去、下次读会崩的坏文件。旧写法
   * `writeFileSync(tmp, undefined)` 是抛 TypeError、目标文件不动。
   */
  for (const bad of [undefined, () => {}, Symbol('x')]) {
    assert.throws(() => writeJsonAtomic(f, bad), TypeError);
  }
  assert.equal(readFileSync(f, 'utf8'), '{"old":1}', '失败时目标文件必须原样不动');
  assert.deepEqual(readdirSync(dir), ['e.json'], '失败后不许留 tmp');
});

test('原子写：tmp 名每次都不一样（同进程连写、多进程共用目录都不撞）', () => {
  const dir = tmpDir();
  const target = join(dir, 'busy');
  /** 目标是已存在的目录：`rename` 必然失败，错误信息里带着 tmp 的完整路径 */
  mkdirSync(target);
  const tmpOf = () => {
    try {
      writeFileAtomic(target, 'x');
    } catch (e) {
      return String(e?.message ?? e);
    }
    throw new Error('本该失败');
  };
  const a = tmpOf();
  const b = tmpOf();
  /**
   * 从错误信息里把 tmp 路径抠出来。两个平台都会带：
   *   Windows `EPERM: operation not permitted, rename '<tmp>' -> '<target>'`
   *   POSIX   `ENOTDIR: not a directory, rename '<tmp>' -> '<target>'`
   */
  const pathOf = (msg) => (msg.match(/['"]([^'"]*\.tmp)['"]/) || [])[1] || '';
  const pa = pathOf(a);
  const pb = pathOf(b);
  assert.ok(pa, `错误信息里没抠到 tmp 路径：${a.slice(0, 200)}`);
  assert.ok(pb, `错误信息里没抠到 tmp 路径：${b.slice(0, 200)}`);
  assert.notEqual(pa, pb, '两次写的 tmp 名一样 —— 那就是固定名，两个写者会互盖');
  /** 形状：`.<basename>.<pid>.<8 位 hex>.tmp`，以 `.` 开头免得被扫描器当扩展 */
  for (const p of [pa, pb]) {
    assert.match(p, new RegExp(`[\\\\/]\\.busy\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`), `tmp 名形状不对：${p}`);
  }
});

test('原子写：多进程同时写同一文件，落盘的永远是某一次完整写入', async () => {
  const dir = tmpDir();
  const f = join(dir, 'race.json');
  /**
   * 4 个进程各紧循环写 700ms、每次 256KB。
   *
   * **不断言「零失败」**：Windows 上多进程 `rename` 抢同一个目标本来就会偶发
   * EPERM/EBUSY（目标正被另一个进程替换），那是 OS 行为，不是命名能解决的。
   * 这里要证的是另外两件更重要的：落盘内容**永远是完整的一次写入**（不会
   * 截断 / 拼接），以及**不留 tmp**。tmp 名唯一性由上一条用例直接钉。
   *
   * 参数走环境变量：`node -e` 下 `process.argv` 是 `[execPath, ...args]`，
   * 没有脚本路径那一位，按下标取很容易错位（错位会写到 cwd 里一个叫 `p1` 的文件）。
   */
  const script = `
    import { writeFileAtomic } from ${JSON.stringify(new URL(`file://${ATOMIC}`).href)};
    const file = process.env.RACE_FILE;
    const tag = process.env.RACE_TAG;
    if (!file || !tag) throw new Error('缺少 RACE_FILE / RACE_TAG');
    let n = 0;
    let fails = 0;
    const end = Date.now() + 700;
    while (Date.now() < end) {
      try {
        writeFileAtomic(file, tag + '#' + n++ + '#' + 'x'.repeat(262144));
      } catch {
        fails += 1;
      }
    }
    console.log(JSON.stringify({ tag, n, fails }));
  `;
  const run = (tag) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RACE_FILE: f, RACE_TAG: tag },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  const results = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(run));
  for (const r of results) {
    assert.equal(r.code, 0, `子进程异常退出：${r.err.slice(0, 300)}`);
    const stat = JSON.parse(r.out.trim().split('\n').pop());
    assert.ok(stat.n > 20, `写得太少（${stat.n} 次），这条用例没真跑到并发`);
  }
  /** 落盘内容必须是某一次**完整**的写入：截断 / 拼接都会在这里露出来 */
  const got = readFileSync(f, 'utf8');
  assert.match(got, /^p[1-4]#\d+#x{262144}$/, '落盘内容不是一次完整写入（被截断或拼接了）');
  assert.deepEqual(readdirSync(dir), ['race.json'], '并发写完也不许留 tmp');
});
