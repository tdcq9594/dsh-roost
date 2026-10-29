// 第五层（自我叙述 / selfNote）的测试。
//
// 这一层最怕的不是写错字，而是两件静默的事：
//   · **写成了第二本日记** —— 注入的每一句都在讲用户，她自己的成长就没了
//   · **该复盘的日子没写** —— 被纠正的那天话少，按量就永远轮不到她
// 所以断言盯三处：素材是不是只有她自己、该不该写、归档之后信息还在不在。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSelf, RE_CORRECTION, MIN_BOT_LINES } from '../src/self.js';
import { createJournal } from '../src/journal.js';
import { createGraph } from '../src/graph.js';
import { createConsolidate, buildSelfPrompt } from '../src/consolidate.js';

const DAY = 86_400_000;

/** 每个用例一个干净的 data 目录（dataDir() 每次读 env，所以换 env 就够） */
function fresh() {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-self-'));
  return createSelf();
}

const dayStr = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------------- 存与读 ---------------- */

test('自述：空内容不写（省得库里出现一条空行）', () => {
  const s = fresh();
  assert.equal(s.add({ text: '   ' }).ok, false);
  assert.equal(s.stats().notes, 0);
});

test('自述：同一天重跑覆盖当天那条，不堆流水账', () => {
  // 巩固可能因为重跑/补跑再写一次。堆起来的话，自述会变成一天一条的重复
  const s = fresh();
  s.add({ text: '今天有点急', day: '2026-10-28', at: Date.parse('2026-10-28T23:00:00') });
  s.add({ text: '今天太急了，下次等他说完', day: '2026-10-28', at: Date.parse('2026-10-28T23:30:00') });
  assert.equal(s.stats().notes, 1);
  assert.equal(s.recent(1)[0].text, '今天太急了，下次等他说完');
});

test('自述：注入的那段要标明"这是你自己写的"', () => {
  // 不这么说，模型会把它当成"用户对我的设定"，然后照着演 —— 那是扮演，不是活着
  const s = fresh();
  s.add({ text: 'A', day: '2026-10-26', at: Date.parse('2026-10-26T23:00:00') });
  s.add({ text: 'B', day: '2026-10-27', at: Date.parse('2026-10-27T23:00:00') });
  const t = s.text(2);
  assert.ok(t.includes('你自己写的'));
  assert.ok(t.includes('10-26 A'));
  assert.ok(t.includes('10-27 B'));
});

test('自述：一条都没有时返回空串，不注入"还没有自述"这种废话', () => {
  assert.equal(fresh().text(3), '');
});

test('自述：存盘后重开还在（不是只活在内存里）', () => {
  const s = fresh();
  s.add({ text: '写下来了', day: '2026-10-28', at: Date.parse('2026-10-28T23:00:00') });
  const again = createSelf(); // 同一个 DSH_ROOST_DATA，模拟重启
  assert.equal(again.recent(1)[0].text, '写下来了');
  const raw = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'self.json'), 'utf8'));
  assert.equal(raw.notes.length, 1);
});

/* ---------------- 归档：压不是删 ---------------- */

test('自述：超过 20 条压成阶段自述（归档不是删除）', () => {
  const s = fresh();
  const base = Date.parse('2026-09-01T23:00:00');
  for (let i = 0; i < 25; i++) {
    const at = base + i * DAY;
    s.add({ text: `第 ${i + 1} 天的反省`, day: dayStr(at), at });
  }
  const all = s.all();
  assert.equal(all.notes.length, 20, '日自述最多留 20 条');
  assert.equal(all.chapters.length, 1, '最旧的 5 条压成 1 段');
  assert.ok(
    all.chapters[0].text.includes('第 1 天的反省'),
    '被压走的内容要在阶段自述里 —— 变抽象，不是消失',
  );
  assert.equal(all.chapters[0].from, dayStr(base), '阶段自述要记下覆盖的日期范围');
  assert.equal(all.chapters[0].to, dayStr(base + 4 * DAY));
  assert.equal(all.notes[0].day, dayStr(base + 5 * DAY), '留下的从第 6 天开始');

  // 归档结果必须落盘：只在内存里压了的话，重启之后旧条目会原地复活，
  // 而当天已经"写过了"不会再压一次 —— 文件就永远超长
  const reopened = createSelf();
  assert.equal(reopened.stats().notes, 20, '重开还是 20 条');
  assert.equal(reopened.stats().chapters, 1, '阶段自述也在盘上');
});

test('自述：阶段自述也有上限，不会无限长', () => {
  const s = fresh();
  const base = Date.parse('2026-01-01T23:00:00');
  for (let i = 0; i < 90; i++) s.add({ text: `第 ${i + 1} 天`, day: dayStr(base + i * DAY), at: base + i * DAY });
  const all = s.all();
  assert.equal(all.notes.length, 20);
  assert.ok(all.chapters.length <= 12, `阶段自述最多 12 段，实际 ${all.chapters.length}`);
  assert.ok(createSelf().all().chapters.length <= 12, '合并结果也要落盘');
});

test('自述：归档就发生在最后一次写入时，也必须落盘', () => {
  // distill() 跑在 save() 之后。它自己不存一次的话，这次压缩只活在内存里；
  // 平时看不出来（下一次 add 的 save 会顺手写下去），但压缩恰好发生在
  // 最后一次写入时就露馅：重启后旧条目原地复活，而那天已经"写过"了、
  // 不会再压 —— 文件就永远超长。21 条正好让压缩落在最后一下。
  const s = fresh();
  const base = Date.parse('2026-09-01T23:00:00');
  for (let i = 0; i < 21; i++) {
    const at = base + i * DAY;
    s.add({ text: `第 ${i + 1} 天`, day: dayStr(at), at });
  }
  const reopened = createSelf();
  assert.equal(reopened.stats().notes, 16, '21 条压掉最旧 5 条');
  assert.equal(reopened.stats().chapters, 1);
});

test('自述：归档是机械合并，不改写内容', () => {
  // 这一步只负责「别让文件无限长」。真要让阶段自述更凝练，那是另一次模型调用，
  // 不该藏在 prune 里 —— 藏进去就变成"悄悄改写历史"
  const s = fresh();
  const base = Date.parse('2026-09-01T23:00:00');
  for (let i = 0; i < 25; i++) {
    const at = base + i * DAY;
    s.add({ text: `原话${i + 1}`, day: dayStr(at), at });
  }
  const ch = s.all().chapters[0].text;
  for (let i = 1; i <= 5; i++) assert.ok(ch.includes(`原话${i}`), `第 ${i} 天要原样留着`);
});

/* ---------------- 忘掉：这一层也要扫 ---------------- */

test('自述：用户说忘掉，这一层也要扫（不然换个说法继续存在）', () => {
  const s = fresh();
  s.add({ text: '今天在杭州说错话了', day: '2026-10-28', at: Date.parse('2026-10-28T23:00:00') });
  s.add({ text: '今天状态还行', day: '2026-10-27', at: Date.parse('2026-10-27T23:00:00') });
  assert.equal(s.forget('杭州'), 1);
  const all = s.all();
  assert.ok(!all.notes.some((n) => n.text.includes('杭州')));
  assert.ok(all.notes.some((n) => n.text === '今天状态还行'), '不相干的不能被误伤');
});

test('自述：压进阶段自述里的也要忘', () => {
  const s = fresh();
  const base = Date.parse('2026-09-01T23:00:00');
  s.add({ text: '在杭州迷路了', day: dayStr(base), at: base });
  for (let i = 1; i < 25; i++) s.add({ text: `第 ${i} 天`, day: dayStr(base + i * DAY), at: base + i * DAY });
  assert.equal(s.all().notes.filter((n) => n.text.includes('杭州')).length, 0, '原文已经压走了');
  assert.equal(s.forget('杭州'), 1, '压走了也得忘');
  assert.ok(s.all().chapters[0].text.includes('遗忘'));
});

test('自述：空关键词不误伤（不然一次误调用就清空全部）', () => {
  const s = fresh();
  s.add({ text: '留着', day: '2026-10-28', at: Date.parse('2026-10-28T23:00:00') });
  assert.equal(s.forget(''), 0);
  assert.equal(s.forget(null), 0);
  assert.equal(s.recent(1)[0].text, '留着');
});

test('自述：清空之后重开也是空的（清的是盘上的）', () => {
  const s = fresh();
  s.add({ text: '一条', day: '2026-10-28', at: Date.parse('2026-10-28T23:00:00') });
  s.clear();
  assert.equal(s.stats().notes, 0);
  assert.equal(createSelf().stats().notes, 0);
});

/* ---------------- 提示词 ---------------- */

test('自述提示词：只写自己、明确排除日记腔和"作为 AI"，并留 skip 出口', () => {
  const p = buildSelfPrompt({ day: '2026-10-28', said: [{ text: '我觉得这样不好' }] });
  assert.ok(p.includes('2026-10-28'));
  assert.ok(p.includes('我觉得这样不好'));
  assert.ok(p.includes('只写你自己'));
  assert.ok(p.includes('不要复述聊了什么'), '不这么写模型会写成第二份日记摘要');
  assert.ok(p.includes('<<skip>>'));
  assert.ok(!p.includes('被纠正的时刻'), '没有纠正时不要留一个空小节');
});

test('自述提示词：有纠正时刻才加那一节', () => {
  const p = buildSelfPrompt({
    day: 'd',
    said: [{ text: 'a' }],
    corrected: [{ text: '不对，我不是那个意思' }],
  });
  assert.ok(p.includes('被纠正的时刻'));
  assert.ok(p.includes('不对，我不是那个意思'));
});

test('自述：纠正的判据宁可宽松（漏判的代价是她永远不知道自己错在哪）', () => {
  assert.ok(RE_CORRECTION.test('不对，我不是这个意思'));
  assert.ok(RE_CORRECTION.test('你记错了'));
  assert.ok(!RE_CORRECTION.test('今天天气不错'));
});

/* ---------------- 巩固里写自述（C 方案：按量 or 被纠正） ---------------- */

const fakeMemory = () => ({ add: () => true });

/**
 * 跑一次巩固。
 * `generate` 会被调两次（巩固的 JSON 一次、自述一次），用例自己按 prompt 分辨。
 */
async function runConsolidate({ self, generate, rows, dry = false }) {
  const day = '2026-10-28';
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(mkdtempSync(join(tmpdir(), 'roost-self-j-')), 'j.sqlite') });
  const g = createGraph({ file: join(mkdtempSync(join(tmpdir(), 'roost-self-g-')), 'g.sqlite') });
  rows.forEach((r, i) => j.add({ id: `r${i}`, at: base + i * 1000, chatId: 'g1', ...r }));
  const c = createConsolidate({
    journal: j,
    graph: g,
    memory: fakeMemory(),
    self,
    generate,
    now: () => Date.parse('2026-10-29T04:00:00'),
  });
  return c.run({ day, dry });
}

const isSelfPrompt = (p) => String(p).includes('你自己说过的话');

test('写自述：说得不够多也没被纠正，就不写（不往库里灌水）', async () => {
  const self = fresh();
  const calls = [];
  const generate = async (p) => {
    calls.push(p);
    return JSON.stringify({ summary: '聊了几句。' });
  };
  const rows = Array.from({ length: 5 }, () => ({ role: 'bot', text: '嗯嗯' }));
  const r = await runConsolidate({ self, generate, rows });

  assert.equal(r.self, 0);
  assert.ok(r.selfSkip.includes('不值得写'), `理由要说得出来，实际：${r.selfSkip}`);
  assert.ok(!calls.some(isSelfPrompt), '不该为自述白调一次模型');
  assert.equal(self.stats().notes, 0);
});

test('写自述：说得够多就写一条，素材里不含对方说的话', async () => {
  const self = fresh();
  const prompts = [];
  const generate = async (p) => {
    prompts.push(p);
    return isSelfPrompt(p) ? '今天太急了，下次等他说完。' : JSON.stringify({ summary: '聊了几句。' });
  };
  const rows = [
    ...Array.from({ length: MIN_BOT_LINES + 2 }, () => ({ role: 'bot', text: '我觉得这个魂骨不错' })),
    { role: 'user', text: '我要去北京了' },
  ];
  const r = await runConsolidate({ self, generate, rows });

  assert.equal(r.self, 1);
  assert.equal(self.recent(1)[0].text, '今天太急了，下次等他说完。');
  const sp = prompts.find(isSelfPrompt);
  assert.ok(sp.includes('我觉得这个魂骨不错'), '她自己说的话要在素材里');
  assert.ok(!sp.includes('我要去北京'), '对方的话不能进自述素材（否则就是第二本日记）');
});

test('写自述：被纠正的日子，话少也要写（C 方案的另一半）', async () => {
  // 纯按量的话，「说错一句就被怼」这天永远轮不到她复盘 —— 而那正是她最该记住的一天
  const self = fresh();
  const generate = async (p) =>
    isSelfPrompt(p) ? '今天理解错了他的意思，下次先问一句再下结论。' : JSON.stringify({ summary: '被纠正了一次。' });
  const rows = [
    { role: 'bot', text: '那你就是不想要了' },
    { role: 'user', text: '不对，我不是这个意思' },
    { role: 'bot', text: '哦哦，那我理解错了' },
  ];
  const r = await runConsolidate({ self, generate, rows });

  assert.equal(r.self, 1, '3 条远不到 20 条，靠"被纠正"触发');
  assert.ok(self.recent(1)[0].text.includes('理解错'));
});

test('写自述：一句没说的日子不写（没有"关于她自己"的素材）', async () => {
  const self = fresh();
  const calls = [];
  const generate = async (p) => {
    calls.push(p);
    return JSON.stringify({ summary: '他一个人在说。' });
  };
  const rows = [
    { role: 'user', text: '不对，你说错了' },
    { role: 'user', text: '算了' },
  ];
  const r = await runConsolidate({ self, generate, rows });

  assert.equal(r.self, 0);
  assert.ok(r.selfSkip.includes('没说话'));
  assert.ok(!calls.some(isSelfPrompt));
});

test('写自述：模型输出 <<skip>> 算正常结局，不写也不报错', async () => {
  const self = fresh();
  const generate = async (p) => (isSelfPrompt(p) ? '<<skip>>' : JSON.stringify({ summary: 'x' }));
  const rows = Array.from({ length: 25 }, () => ({ role: 'bot', text: '嗯' }));
  const r = await runConsolidate({ self, generate, rows });

  assert.equal(r.self, 0);
  assert.ok(r.selfSkip.includes('没什么可写'));
  assert.deepEqual(r.errors, [], 'skip 是正常结局，不该进 errors');
  assert.equal(self.stats().notes, 0);
});

test('写自述：注入前把 <<标记>> 和包裹引号摘掉', async () => {
  // 自述是要塞进提示词的，留着 `<<note>>` 等于把内部标记漏给模型
  const self = fresh();
  const generate = async (p) => (isSelfPrompt(p) ? '「<<note>>今天话太多了」' : JSON.stringify({ summary: 'x' }));
  const rows = Array.from({ length: 25 }, () => ({ role: 'bot', text: '嗯' }));
  await runConsolidate({ self, generate, rows });
  assert.equal(self.recent(1)[0].text, '今天话太多了');
});

test('写自述：dry 模式不落盘（调试不能写脏数据）', async () => {
  const self = fresh();
  const generate = async () => '今天有反省。';
  const rows = Array.from({ length: 25 }, () => ({ role: 'bot', text: '嗯' }));
  const r = await runConsolidate({ self, generate, rows, dry: true });

  assert.equal(r.dry, true);
  assert.equal(r.self, 0);
  assert.equal(self.stats().notes, 0);
});
