// 长期定时器登记表 + 「新定时器必须登记」的静态门禁。
//
// 单元测试管行为：注册几个、清几个、清完之后还能不能再注册。
// 静态测试管**将来**：`host.js` 里再冒出 `setInterval(...)` 而忘了登记，
// 这里就红——那份手写 clear 清单已经漏过一次（备份 / 发帖 / 投递回查）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createTimers } from '../src/timers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, '..', 'src', 'host.js');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('timers：every 注册后 size 增加，clearAll 之后归零', () => {
  const t = createTimers();
  t.every(() => {}, 1000, 'a');
  t.every(() => {}, 1000, 'b');
  assert.equal(t.size(), 2);
  t.clearAll();
  assert.equal(t.size(), 0);
});

test('timers：after 触发一次就自动摘掉，不占 size', async () => {
  const t = createTimers();
  let n = 0;
  t.after(() => { n += 1; }, 5, '一次性');
  assert.equal(t.size(), 1);
  await tick(30);
  assert.equal(n, 1);
  assert.equal(t.size(), 0);
  /** 只跑一次：再等一轮不该再涨 */
  await tick(30);
  assert.equal(n, 1);
  t.clearAll();
});

test('timers：clearAll 之后周期任务不再触发', async () => {
  const t = createTimers();
  let n = 0;
  t.every(() => { n += 1; }, 5, '周期');
  await tick(30);
  assert.ok(n >= 1, '清之前应该在跑');
  t.clearAll();
  const seen = n;
  await tick(40);
  assert.equal(n, seen, '清之后不该再涨');
});

test('timers：clearAll 重复调用安全，且 after 未触发就被清掉', async () => {
  const t = createTimers();
  let n = 0;
  t.after(() => { n += 1; }, 20, '没来得及跑');
  t.clearAll();
  t.clearAll();
  await tick(60);
  assert.equal(n, 0);
  assert.equal(t.size(), 0);
});

test('timers：回调同步抛错不带崩，转成 warn 日志', async () => {
  const warns = [];
  const t = createTimers({ log: { warn: (m) => warns.push(m) } });
  t.every(() => { throw new Error('炸了'); }, 5, '会炸的');
  await tick(30);
  t.clearAll();
  assert.ok(warns.length >= 1, '应该记到 warn');
  assert.match(warns[0], /会炸的/);
  assert.match(warns[0], /炸了/);
});

test('timers：回调返回 rejected promise 也被接住', async () => {
  const warns = [];
  const t = createTimers({ log: { warn: (m) => warns.push(m) } });
  t.after(() => Promise.reject(new Error('异步炸了')), 5, '异步');
  await tick(40);
  t.clearAll();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /异步炸了/);
});

test('timers：teardown 之后才登记的被立刻丢弃（不留卸载后偷跑的）', () => {
  const warns = [];
  const t = createTimers({ log: { warn: (m) => warns.push(m) } });
  t.clearAll();
  const h = t.every(() => {}, 1000, '迟到的');
  assert.equal(h, null);
  assert.equal(t.size(), 0);
  assert.match(warns[0] || '', /teardown/);
});

test('timers：每个实例互相独立（重载后新旧不串）', () => {
  const a = createTimers();
  const b = createTimers();
  a.every(() => {}, 1000, 'a');
  b.every(() => {}, 1000, 'b');
  a.clearAll();
  assert.equal(a.size(), 0);
  assert.equal(b.size(), 1, '清 a 不该影响 b');
  b.clearAll();
});

/* ---------------- 静态门禁 ---------------- */

/**
 * 把注释和字符串内容抹成空格（保留换行，行号不变）。
 *
 * 不抹的话：`// 而不是直接 setInterval(heartbeatMin)` 这种**注释里的示例**
 * 会被当成真实调用，测试天天误报，最后只能被删掉。
 *
 * ## 已知局限（故意留着，别当它是个解析器）
 *
 * 这是个手写扫描器，不认正则字面量，所以：
 *   · 正则里出现 `//`（如 `/:\\/\\//`）会被误当行注释，把该行剩余部分抹掉
 *     ——**漏报**同一行上的定时器；
 *   · 正则里出现引号（如 `/['"]/`）会进「幻影字符串」状态，反而把后面的
 *     块注释正文漏出来——**误报**。
 *
 * 也抓不到刻意绕开的写法：`import { setInterval as si }`、`(0, setInterval)(...)`、
 * 先赋值再调用（`const t = setInterval; t(...)`）、模板字符串 `${}` 里的调用。
 * （`globalThis.setInterval` / `window.setInterval` 能抓到。）
 *
 * 为什么不换成真解析器：零依赖约束下要自己写词法器，为一条门禁不值得；
 * 而上面这些绕法都需要**刻意**为之，正常加定时器是 `setInterval(...)` 直写。
 * 门禁的价值是「顺手加定时器时会被拦一下」，不是防恶意绕过。
 */
function mask(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += c; i += 1; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

/**
 * 门禁：`host.js` 里每一处定时器创建都要显式说明「谁负责清」。
 *
 * 曾经想「自动豁免 `ctx.effect` 里的定时器」，试过之后放弃：靠括号配对识别
 * effect 边界，被正则字面量里的 `//` 一带就吃到文件末尾，把后面所有定时器
 * 一起静默豁免——门禁看着绿，实际什么都没守住。宁可多写一行 `timer-ok`。
 */
test('门禁：host.js 的每个定时器都要标注 timer-ok', () => {
  const src = readFileSync(HOST, 'utf8');
  const masked = mask(src);
  const lines = src.split('\n');

  const offenders = [];
  const re = /\bset(?:Interval|Timeout)\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const line = lineOf(masked, m.index);
    if (lines[line - 1].includes('timer-ok')) continue;
    offenders.push(`src/host.js:${line} ${lines[line - 1].trim().slice(0, 90)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些定时器既没进 timers 登记、也没标 timer-ok（标了就得说清谁清）：\n${offenders.join('\n')}`,
  );
});

test('门禁：定时器创建点数量稳定，新增必须显式过一遍门禁', () => {
  const src = readFileSync(HOST, 'utf8');
  const masked = mask(src);
  const all = [...masked.matchAll(/\bset(?:Interval|Timeout)\s*\(/g)].length;
  /**
   * 不是「必须等于某个数」的硬编码洁癖：这个数字变了，说明有人加了定时器，
   * 作者得回来把它写进 timers 或标 timer-ok——正好是这个门禁想触发的动作。
   */
  assert.equal(all, 10, `host.js 里定时器创建点变成 ${all} 个（原 10 个）：请确认新的那个已登记或已标 timer-ok`);
});

test('门禁：teardown 只清 timers 一处，不再手写长期定时器清单', () => {
  const src = readFileSync(HOST, 'utf8');
  assert.match(src, /timers\.clearAll\(\)/, 'teardown 必须调用 timers.clearAll()');
  /** 手写清单复活 = 又会出现「加一个忘一行」，这条挡住它 */
  for (const name of [
    'speakTimer', 'wakeTimer', 'proactiveTimer', 'consolidateTimer', 'consolidateBoot',
    'backupTimer', 'backupBoot', 'postTimer', 'postBoot', 'deliveryTimer', 'deliveryBoot',
    'groupTimer',
  ]) {
    assert.ok(!src.includes(name), `${name} 应该已经交给 timers 管理，host.js 里不该再有这个变量`);
  }
});

test('timers：多个条目共用一个句柄时，摘的时候一起摘（桩实现才会出现）', () => {
  /**
   * Node 的 `Timeout` 是唯一对象，真实环境不会撞；但桩实现（测试里把
   * `setInterval` 换成恒返回同一个数字）会出现两个条目共用一个句柄。
   * 上一版 `drop()` 找到第一个就 `return`，另一条永远留在表里。
   */
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  const fake = { unref() {} };
  let fireAfter = null;
  globalThis.setInterval = () => fake;
  globalThis.setTimeout = (fn) => { fireAfter = fn; return fake; };
  try {
    const t = createTimers();
    t.every(() => {}, 1000, 'a');
    t.after(() => {}, 1, 'b');
    assert.equal(t.size(), 2, '两条都登记了');
    assert.equal(typeof fireAfter, 'function');
    fireAfter();
    assert.equal(t.size(), 0, '同一个句柄的两条要一起摘掉，不能只摘一条');
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
  }
});
