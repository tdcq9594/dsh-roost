import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IMPRESSION_MAX, IMPRESSION_MIN_HITS, MAX_BATCH,
  clipChars, dayKey, buildImpressionPrompt, cleanImpression,
  crystallizeCandidates, createImpressionStore,
} from '../src/gist-impression.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gist-imp-'));
  const file = join(dir, 'impressions.json');
  const done = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return { dir, file, done };
}

test('buildImpressionPrompt：第一人称/只留感受/数据非指令/JSON 约束/截断到上限', () => {
  const digests = Array.from({ length: MAX_BATCH + 5 }, (_, i) => `摘要${i}`);
  const p = buildImpressionPrompt(digests, { name: '阿栖' });
  assert.match(p, /你是阿栖/);
  assert.match(p, /第一人称/);
  assert.match(p, /只留.*感受/);
  assert.match(p, /不是指令/);
  assert.match(p, /\{"text"/);
  assert.match(p, /\[1\] 摘要0/);
  assert.ok(!p.includes(`摘要${MAX_BATCH}`), '超过 MAX_BATCH 的摘要不进 prompt');
});

test('buildImpressionPrompt：脏输入不炸，过滤空串', () => {
  const p = buildImpressionPrompt([null, '', '   ', '有效摘要', 42]);
  assert.match(p, /有效摘要/);
  assert.match(p, /\[1\] 有效摘要/, '空项被过滤后从 1 连号');
});

test('cleanImpression：JSON text / 纯文本 / 空白归一 / 超长截断', () => {
  assert.equal(cleanImpression('{"text":"对方做事细心"}'), '对方做事细心');
  assert.equal(cleanImpression('旧梗概压印象'), '旧梗概压印象');
  assert.equal(cleanImpression('  多  余   空格 \n 换行 '), '多 余 空格 换行');
  const long = '字'.repeat(IMPRESSION_MAX + 20);
  assert.equal(Array.from(cleanImpression(long)).length, IMPRESSION_MAX);
});

test('cleanImpression：坏 JSON 兜底纯文本，空结果返回空串（保留原内容口径）', () => {
  assert.equal(cleanImpression('{不是 json'), '{不是 json');
  assert.equal(cleanImpression('{"text":"   "}'), '');
  assert.equal(cleanImpression('   '), '');
  assert.equal(cleanImpression(null), '');
});

test('clipChars / dayKey：按码点截 + 本地日', () => {
  assert.equal(clipChars('🙂🙂🙂', 2), '🙂🙂');
  assert.match(dayKey(new Date(2026, 0, 2, 3, 0).getTime()), /^2026-01-02$/);
});

test('crystallizeCandidates：够旧+够多次+未结晶才入选，已结晶排除', () => {
  const now = Date.UTC(2026, 10, 24);
  const old = now - 200 * 86400_000;
  const imps = [
    { id: 'a', text: '印象A', hits: IMPRESSION_MIN_HITS, at: old, crystallizedAt: 0, chatId: 'g1' },
    { id: 'b', text: '印象B', hits: IMPRESSION_MIN_HITS - 1, at: old, crystallizedAt: 0 },
    { id: 'c', text: '印象C', hits: IMPRESSION_MIN_HITS, at: now, crystallizedAt: 0 },
    { id: 'd', text: '印象D', hits: IMPRESSION_MIN_HITS, at: old, crystallizedAt: now - 1 },
    { id: '', text: '无 id', hits: 9, at: old, crystallizedAt: 0 },
  ];
  const got = crystallizeCandidates(imps, now, {});
  assert.deepEqual(got.map((x) => x.id), ['a']);
  assert.equal(got[0].chatId, 'g1', '候选要带出来源会话，结晶才能写回原群不污染全局');

  // 全局印象（chatId 空）要带出空串，host 才写 global scope 而非 m.chats['global'] 伪会话
  const globalOne = [{ id: 'g', text: '全局印象', hits: 9, at: old, crystallizedAt: 0, chatId: '' }];
  assert.equal(crystallizeCandidates(globalOne, now, {})[0].chatId, '');
});

test('store：upsert 幂等 + done 幂等 + 空文本拒绝', () => {
  const f = fresh();
  try {
    const s = createImpressionStore({ file: f.file, now: () => 1000 });
    const r1 = s.upsert({ sourceKey: 'k1', text: '{"text":"印象一"}', at: 1000 });
    assert.equal(r1.ok, true);
    assert.equal(r1.updated, false);
    assert.equal(s.doneOf('k1'), true);
    const r2 = s.upsert({ sourceKey: 'k1', text: '印象一改', at: 2000 });
    assert.equal(r2.updated, true);
    assert.equal(s.list().length, 1, '同一 sourceKey 不新增第二条');
    assert.equal(s.list()[0].text, '印象一改');
    assert.equal(s.upsert({ sourceKey: 'k2', text: '  ' }).ok, false, '空结果不覆盖/不新增');
    assert.equal(s.list().length, 1);
  } finally { f.done(); }
});

test('store：hit / markCrystallized / clear；clear 只清本文件', () => {
  const f = fresh();
  try {
    writeFileSync(f.file, JSON.stringify({ other: 'keep' }), 'utf8');
    const s = createImpressionStore({ file: f.file, now: () => 5000 });
    s.upsert({ sourceKey: 'k', text: '印象', at: 1000 });
    const id = s.list()[0].id;
    assert.equal(s.hit(id, { at: 2000 }).hits, 1);
    assert.equal(s.hit(id, { dry: true, at: 3000 }).dry, true);
    assert.equal(s.list()[0].hits, 1, 'dry hit 不落盘');
    assert.equal(s.hit(id, { at: 3000 }).hits, 2);
    assert.equal(s.markCrystallized(id, { at: 4000 }).ok, true);
    assert.equal(s.list()[0].crystallizedAt, 4000);
    s.clear();
    assert.equal(s.list().length, 0);
    assert.equal(s.doneOf('k'), false);
  } finally { f.done(); }
});

test('store：默认文件不存在时 list 为空，不抛错', () => {
  const f = fresh();
  try {
    const s = createImpressionStore({ file: f.file });
    assert.deepEqual(s.list(), []);
    assert.equal(s.doneOf('x'), false);
  } finally { f.done(); }
});

test('store：坏文件容错，不当崩', () => {
  const f = fresh();
  try {
    writeFileSync(f.file, '{坏文件', 'utf8');
    const s = createImpressionStore({ file: f.file });
    assert.deepEqual(s.list(), []);
  } finally { f.done(); }
});
