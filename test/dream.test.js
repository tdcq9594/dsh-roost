/**
 * 做梦（dream.js）的单测。
 *
 * 重点不是"能跑通"，而是三条红线：
 *   · 没素材不写文件（否则这天被标记成做过梦，明天补不回来）
 *   · 模型失败时**不写自述**（机械记录只进文件）
 *   · 一天最多一次
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDream, parseDream, buildDreamPrompt, readDreamSeeds } from '../src/dream.js';
import { createJournal } from '../src/journal.js';
import { createSelf } from '../src/self.js';

const DAY = 86_400_000;

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-dream-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  process.env.DSH_ROOST_DATA = data;
  return data;
}

/** 造一天：两条聊天 + 一条摘要（巩固写的那种行） */
function seedDay(j, day) {
  const base = Date.parse(`${day}T10:00:00`);
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '今天聊了搬家的事' });
  j.add({ id: 'b', at: base + 1000, chatId: 'g1', sender: '我', role: 'bot', kind: 'chat', text: '搬去哪了' });
  j.add({ id: `day:${day}:g1`, at: base + 2000, chatId: 'g1', role: 'digest', kind: 'digest', text: '甲说下个月搬到上海' });
}

test('做梦：模型输出容错（围栏 / 废话 / 字符串字段 / 超长截断）', () => {
  const a = parseDream('```json\n{"reflection":["别急着给建议","搬家别催","先问一句"],"tomorrow":["问问他搬家"]}\n```');
  assert.deepEqual(a.reflection, ['别急着给建议', '搬家别催', '先问一句']);
  assert.deepEqual(a.tomorrow, ['问问他搬家']);

  const b = parseDream('好的，我想了想：{"reflection":"只有一句","tomorrow":[]} 就这样');
  assert.deepEqual(b.reflection, ['只有一句'], '字段写成字符串也认');
  assert.deepEqual(b.tomorrow, []);

  const c = parseDream(`{"reflection":["${'长'.repeat(100)}"]}`);
  assert.equal([...c.reflection[0]].length, 60, '超长截断到 60 字');

  const d = parseDream('完全不是 JSON');
  assert.deepEqual(d, { reflection: [], tomorrow: [] }, '认不出来给空，不编');
});

test('做梦：提示词明确「不要复述」并带上素材', () => {
  const p = buildDreamPrompt({
    day: '2026-11-22', name: '阿罗',
    digests: ['g1：甲说搬到上海'],
    facts: ['甲下个月搬家'],
    stats: '立项 1 次、推进 2 次、被拦 0 次',
    selfText: '我是个爱较真的家伙',
    recent: ['昨天想到：别急着给建议'],
  });
  assert.ok(p.includes('不要复述今天发生了什么'), '要明确禁止复述');
  assert.ok(p.includes('阿罗'));
  assert.ok(p.includes('甲说搬到上海'));
  assert.ok(p.includes('甲下个月搬家'));
  assert.ok(p.includes('推进 2 次'));
  assert.ok(p.includes('别急着给建议'), '前几天的梦要带上（防重复）');
});

test('做梦：没素材不写文件（否则这天就再也补不回来了）', async () => {
  fresh();
  const day = '2026-11-22';
  const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'j.sqlite') });
  const self = createSelf();
  const d = createDream({ journal: j, self, generate: async () => '{}' });
  const r = await d.run({ day });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有素材/);
  assert.equal(existsSync(join(process.env.DSH_ROOST_DATA, 'dreams', `${day}.md`)), false, '不该留下文件');
  assert.equal(d.due(day), true, '还能补做');
  try { j.close(); } catch {}
});

test('做梦：有素材就写 md + 一条 dream 自述，一天最多一次', async () => {
  fresh();
  const day = '2026-11-22';
  const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'j.sqlite') });
  seedDay(j, day);
  const self = createSelf();
  const d = createDream({
    journal: j, self,
    generate: async () => JSON.stringify({
      reflection: ['给建议前先问一句他想要什么', '搬家这种事别催'],
      tomorrow: ['问问他上海的房子找得怎么样'],
    }),
    now: () => Date.parse(`${day}T23:30:00`),
  });

  const r = await d.run({ day });
  assert.equal(r.ok, true);
  assert.equal(r.reflection, 2);
  assert.equal(r.tomorrow, 1);
  assert.equal(r.mode, 'model');

  const md = readFileSync(join(process.env.DSH_ROOST_DATA, 'dreams', `${day}.md`), 'utf8');
  assert.ok(md.includes('甲说下个月搬到上海'), '摘要要进文件');
  assert.ok(md.includes('给建议前先问一句'), '反思要进文件');
  assert.ok(md.includes('## 明天想做的事'));

  const notes = self.all().notes.filter((n) => n.kind === 'dream');
  assert.equal(notes.length, 1, '自述写一条');
  assert.ok(notes[0].text.includes('给建议前先问一句'));

  /** 一天最多一次 */
  assert.equal(d.due(day), false);
  const again = await d.run({ day });
  assert.equal(again.ok, false);
  assert.match(again.reason, /已经做过梦/);
  try { j.close(); } catch {}
});

test('做梦：模型失败时只留机械记录，**不写自述**', async () => {
  fresh();
  const day = '2026-11-22';
  const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'j.sqlite') });
  seedDay(j, day);
  const self = createSelf();
  const d = createDream({ journal: j, self, generate: async () => { throw new Error('网络炸了'); } });

  const r = await d.run({ day });
  assert.equal(r.ok, true, '文件还是写（能看出这天做过梦）');
  assert.equal(r.mode, 'mechanical');
  assert.equal(r.reflection, 0);

  const md = readFileSync(join(process.env.DSH_ROOST_DATA, 'dreams', `${day}.md`), 'utf8');
  assert.ok(md.includes('只留机械记录'));
  assert.equal(self.all().notes.filter((n) => n.kind === 'dream').length, 0, '不能往自述里塞废话');
  try { j.close(); } catch {}
});

test('做梦：明天想做的事会写成种子，自驱能读到；最近几天的梦能列出来', async () => {
  fresh();
  const day = '2026-11-22';
  const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'j.sqlite') });
  seedDay(j, day);
  const d = createDream({
    journal: j, self: createSelf(),
    generate: async () => JSON.stringify({ reflection: ['一句话反思'], tomorrow: ['去查查上海的天气'] }),
  });
  await d.run({ day });

  assert.deepEqual(readDreamSeeds(3), ['去查查上海的天气'], '种子要能被自驱读到');
  const list = d.recent(7);
  assert.equal(list.length, 1);
  assert.equal(list[0].day, day);
  assert.ok(list[0].text.includes('去查查上海的天气'));
  try { j.close(); } catch {}
});

test('做梦：日期只认 YYYY-MM-DD（防目录穿越）', async () => {
  fresh();
  const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'j.sqlite') });
  const d = createDream({ journal: j, self: createSelf(), generate: async () => '{}' });
  /**
   * `day` 来自 /quick 的 arg.day，扩展也能传。以前直接拼进路径：
   * `../../evil` 会写到数据目录外面。
   */
  const r = await d.run({ day: '../../evil' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /日期不合法/);
  assert.equal(d.text('../../evil'), '', '读也不能穿越');
  assert.equal(d.due('../../evil'), false, '非法日期不当"该做梦"');
  try { j.close(); } catch {}
});
