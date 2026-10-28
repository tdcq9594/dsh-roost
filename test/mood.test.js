/**
 * 情绪系统的测试。
 *
 * 为什么这个文件是补上的而不是一开始就有：`mood.js` 是整套里唯一
 * **带数值状态**的模块，却一条测试都没有。代价是三个 bug 一起活了很久——
 * 面板按钮传错值、`touched()` 无冷却把数值顶满、低情绪阈值数学上够不到。
 * 这三个都只需要一条断言就能发现。
 *
 * 跑法：node --test test/mood.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 每个用例一份独立数据目录。
 *
 * `mood.js` 是**有状态**的（落盘 + 模块内缓存），共用目录会互相污染，
 * 那种失败最难查——单跑过、一起跑挂。
 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-mood-'));
  process.env.DSH_ROOST_DATA = dir;
  return {
    dir,
    /**
     * 清理失败不算测试失败。
     *
     * Windows 上 `rmSync` 偶发 ENOTEMPTY（文件句柄还没释放），
     * 那跟被测代码毫无关系——不能让它把一条本来通过的用例判红。
     * 临时目录留着无所谓，系统会自己清。
     */
    done: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* 忽略 */
      }
    },
  };
}

const realNow = Date.now;
/** 假时钟的偏移量。**必须累积**——每次用 realNow()+ms 会原地踏步，时间永远不前进 */
let offset = 0;
const jump = (ms) => {
  offset += ms;
  Date.now = () => realNow() + offset;
};
const restoreClock = () => {
  offset = 0;
  Date.now = realNow;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/* ---------------- 反馈归一化 ---------------- */

test('反馈：面板的 up/down 要能认', async () => {
  const { normalizeFeedback } = await import('../src/mood.js');
  assert.equal(normalizeFeedback('up'), 'LIKE');
  assert.equal(normalizeFeedback('down'), 'UNLIKE');
});

test('反馈：大小写和中文都认', async () => {
  const { normalizeFeedback } = await import('../src/mood.js');
  assert.equal(normalizeFeedback('LIKE'), 'LIKE');
  assert.equal(normalizeFeedback('like'), 'LIKE');
  assert.equal(normalizeFeedback('unlike'), 'UNLIKE');
  assert.equal(normalizeFeedback('点赞'), 'LIKE');
  assert.equal(normalizeFeedback('踩'), 'UNLIKE');
});

test('反馈：认不出来就返回空串，不猜', async () => {
  const { normalizeFeedback } = await import('../src/mood.js');
  assert.equal(normalizeFeedback(''), '');
  assert.equal(normalizeFeedback('随便什么'), '');
  assert.equal(normalizeFeedback(null), '');
});

/* ---------------- `<<mood:>>` 解析 ---------------- */

test('标记：key=value 正常解析', async () => {
  const { parseMoodMark } = await import('../src/mood.js');
  assert.deepEqual(parseMoodMark('valence=-0.3, reason=被凶了'), { valence: -0.3, reason: '被凶了' });
  assert.deepEqual(parseMoodMark('energy=0.2'), { energy: 0.2 });
});

test('标记：原因里带逗号不能被截断', async () => {
  const { parseMoodMark } = await import('../src/mood.js');
  // 按逗号切的老实现会丢掉后半句，原因只剩「被凶了」
  assert.deepEqual(parseMoodMark('reason=被凶了，有点难受'), { reason: '被凶了，有点难受' });
});

test('标记：空格分隔也认', async () => {
  const { parseMoodMark } = await import('../src/mood.js');
  assert.deepEqual(parseMoodMark('energy=0.2 sociability=0.1'), { energy: 0.2, sociability: 0.1 });
});

test('标记：整段没有 key 时当原因', async () => {
  const { parseMoodMark } = await import('../src/mood.js');
  assert.deepEqual(parseMoodMark('心情好了一点，因为被夸了'), { reason: '心情好了一点，因为被夸了' });
});

test('标记：数值不合法就跳过，不写 0', async () => {
  const { parseMoodMark } = await import('../src/mood.js');
  // Number('abc') 是 NaN，老代码 `Number.isFinite` 挡住了；
  // 但要防的是另一头：不能把它当 0 写进去
  assert.deepEqual(parseMoodMark('valence=abc'), {});
});

/* ---------------- 反馈真的改变数值 ---------------- */

test('反馈：up 真的把心情往上推（面板按钮的老 bug）', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    const before = m.get();
    const r = m.feedback('up');
    assert.equal(r.applied, true);
    assert.ok(r.valence > before.valence, `valence 应该上升：${before.valence} -> ${r.valence}`);
    assert.equal(r.reason, '被夸了');
  } finally {
    done();
  }
});

test('反馈：认不出来的值不改数值，并且如实说没生效', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    const before = m.get();
    const r = m.feedback('随便什么');
    assert.equal(r.applied, false);
    assert.equal(r.valence, before.valence);
    assert.equal(r.sociability, before.sociability);
  } finally {
    done();
  }
});

/* ---------------- touched 的冷却与渐近 ---------------- */

test('touched：连发三条不能把数值顶满', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.touched();
    m.touched();
    m.touched();
    const s = m.get();
    // 老实现是 +0.15/条，第三条就 1.0 了
    assert.ok(s.sociability < 0.8, `社交意愿不该顶满：${s.sociability}`);
    assert.ok(s.energy < 0.85, `精力不该顶满：${s.energy}`);
  } finally {
    done();
  }
});

test('touched：隔开冷却时间才继续回升，且不会超过目标', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    let last = m.touched().sociability;
    for (let i = 0; i < 30; i++) {
      jump(10 * MIN);
      const cur = m.touched().sociability;
      assert.ok(cur >= last - 1e-9, '回升过程中不该往回掉');
      last = cur;
    }
    // 渐近目标 0.75，聊一辈子也到不了 1
    assert.ok(last <= 0.75 + 1e-6, `不该超过渐近目标：${last}`);
    assert.ok(last > 0.7, `聊这么久该靠近目标：${last}`);
  } finally {
    restoreClock();
    done();
  }
});

/* ---------------- 衰减 ---------------- */

test('衰减：落点是 0.5，不会掉到 0.4 以下', async () => {
  const { dir, done } = fresh();
  const { createMood, NEUTRAL, LOW } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.touched();
    jump(30 * 24 * HOUR); // 放一个月
    const s = m.get();
    assert.ok(Math.abs(s.energy - NEUTRAL) < 1e-6, `精力该回到中性：${s.energy}`);
    assert.ok(Math.abs(s.sociability - NEUTRAL) < 1e-6, `社交意愿该回到中性：${s.sociability}`);
    // 这条是核心：衰减**够不到**「低」的阈值，低情绪只能由事件造成
    assert.ok(s.sociability > LOW, '衰减不该把数值拉到「低」以下');
  } finally {
    restoreClock();
    done();
  }
});

test('衰减：被踩到低点之后会自己回来', async () => {
  const { dir, done } = fresh();
  const { createMood, NEUTRAL, LOW } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.feedback('down'); // 社交意愿 -0.15
    m.feedback('down');
    const low = m.get().sociability;
    assert.ok(low < NEUTRAL, `踩两次该低于中性：${low}`);
    jump(12 * HOUR);
    const back = m.get().sociability;
    assert.ok(back > low, '该自己回升');
    assert.ok(back < NEUTRAL + 1e-6, '不该超过中性');
    assert.ok(LOW > 0, '阈值常量要导出给消费方对齐');
  } finally {
    restoreClock();
    done();
  }
});

/* ---------------- reason 的保质期 ---------------- */

test('reason：过期之后不再影响语气', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.feedback('up');
    assert.ok(m.text().includes('被夸了'), '刚写下时应该带上原因');
    jump(7 * HOUR); // REASON_TTL 是 6 小时
    const t = m.text();
    assert.ok(!t.includes('被夸了'), `过期后不该再提原因：${t}`);
  } finally {
    restoreClock();
    done();
  }
});

/* ---------------- 语气指令本身 ---------------- */

test('语气：低数值能说出「累」和「不想搭话」', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.set({ energy: 0.2, sociability: 0.2 });
    const t = m.text();
    // 老实现里这两句永远不出现，因为衰减到不了 0.3 以下
    assert.ok(t.includes('有点累'), t);
    assert.ok(t.includes('不太想主动搭话'), t);
  } finally {
    done();
  }
});

test('语气：高数值能说出「精神很好」和「想聊天」', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.set({ energy: 0.95, sociability: 0.95 });
    const t = m.text();
    assert.ok(t.includes('精神很好'), t);
    assert.ok(t.includes('挺想聊天的'), t);
  } finally {
    done();
  }
});

test('语气：中性时不带任何倾向', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    const t = m.text();
    assert.ok(t.includes('心情一般'), t);
    assert.ok(!t.includes('累'), t);
    assert.ok(!t.includes('想聊天'), t);
  } finally {
    done();
  }
});

/* ---------------- 边界 ---------------- */

test('set：超出范围的值被夹住', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const m = createMood();
    m.set({ valence: 9, energy: -3, sociability: 42 });
    const s = m.get();
    assert.equal(s.valence, 1);
    assert.equal(s.energy, 0);
    assert.equal(s.sociability, 1);
  } finally {
    done();
  }
});

test('落盘：重开一个实例能读回同样的值', async () => {
  const { dir, done } = fresh();
  const { createMood } = await import('../src/mood.js');
  try {
    const a = createMood();
    a.set({ valence: -0.5, energy: 0.3 });
    const b = createMood();
    const s = b.get();
    assert.ok(Math.abs(s.valence - -0.5) < 1e-9, `${s.valence}`);
    assert.ok(Math.abs(s.energy - 0.3) < 1e-9, `${s.energy}`);
  } finally {
    done();
  }
});

test('兼容：老 mood.json 没有 reasonAt 也能读', async () => {
  const { dir, done } = fresh();
  const { writeFileSync } = await import('node:fs');
  const { createMood } = await import('../src/mood.js');
  try {
    writeFileSync(
      join(dir, 'mood.json'),
      JSON.stringify({ valence: 0.1, energy: 0.7, sociability: 0.7, updatedAt: realNow(), reason: '被夸了' }),
      'utf8',
    );
    const m = createMood();
    const s = m.get();
    assert.ok(Math.abs(s.energy - 0.7) < 1e-6, `${s.energy}`);
    // 没有 reasonAt 当 0（= 已过期），不能因为一条陈年原因一直影响语气
    assert.ok(!m.text().includes('被夸了'), '老数据里的 reason 不该无期限生效');
  } finally {
    done();
  }
});
