// 自驱观察层：纠偏识别、显著性、append 门控、落盘与查询。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserve, createEmotionBridge, matchCorrection, salienceOf, OBSERVE_SOURCES } from '../src/autotelic-observe.js';

test('matchCorrection：识别「别做X / 别再X / 别X了」', () => {
  assert.equal(matchCorrection('别再刷B站了')?.target, 'B站', '动词被正则吃掉，target 是对象');
  assert.equal(matchCorrection('别熬夜了')?.target, '熬夜');
  assert.equal(matchCorrection('不要再提那件事')?.target, '那件事', '「提」是动词，对象是「那件事」');
  assert.equal(matchCorrection('今天天气不错'), null);
  assert.equal(matchCorrection(''), null);
});

test('salienceOf：纠偏最高，短普通句最低，情绪/问句抬高', () => {
  assert.equal(salienceOf('别再刷B站了'), 1, '纠偏必须最高');
  assert.ok(salienceOf('嗯') < 0.2, '太短太淡');
  assert.ok(salienceOf('你今天是不是很累啊？') > salienceOf('嗯'), '问句+情绪词更高');
  assert.ok(salienceOf('帮我记住这件事') > 0.3);
  assert.equal(salienceOf(''), 0);
});

test('createObserve：append 校验 source/tag/空文本/低显著度', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    const ob = createObserve({ file: join(dir, 'o.jsonl'), now: () => 1000, hooks: { write: () => {} } });
    assert.equal(ob.append({ source: 'bad', tag: '牵挂', text: 'x' }).reason, 'bad-source');
    assert.equal(ob.append({ source: 'chat', tag: '不存在的tag', text: 'x' }).reason, 'bad-tag');
    assert.equal(ob.append({ source: 'chat', tag: '牵挂', text: '   ' }).reason, 'empty-text');
    assert.equal(ob.append({ source: 'chat', tag: '牵挂', text: '嗯' }).reason, 'low-salience', '太淡不入库');
    const ok = ob.append({ source: 'chat', tag: '牵挂', text: '主人说最近工作压力很大', salience: 0.9 });
    assert.equal(ok.ok, true);
    assert.equal(ok.row.tag, '牵挂');
    assert.equal(ok.row.salience, 0.9);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createObserve：flush 落盘后能 list/byTag/stats 读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob2-'));
  try {
    const file = join(dir, 'o.jsonl');
    const ob = createObserve({ file, now: () => 1000 });
    ob.append({ source: 'chat', tag: '牵挂', text: '主人最近很忙很累', salience: 0.9 });
    ob.append({ source: 'note', tag: '好奇', text: '想弄明白那个原理', salience: 0.6 });
    ob.flush();
    const all = ob.list({});
    assert.equal(all.length, 2);
    assert.equal(ob.byTag('牵挂').length, 1);
    const st = ob.stats();
    assert.equal(st.total, 2);
    assert.equal(st.bySource.chat, 1);
    assert.ok(readFileSync(file, 'utf8').trim().split('\n').length === 2, '一行一条 JSONL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createObserve：observeCorrection 写高显著度 note 并回调', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob3-'));
  try {
    let hit = null;
    const ob = createObserve({
      file: join(dir, 'o.jsonl'), now: () => 1000,
      hooks: { write: () => {}, onCorrection: (x) => { hit = x; } },
    });
    const r = ob.observeCorrection('别再刷B站了', { tag: '牵挂' });
    assert.ok(r);
    assert.equal(r.target, 'B站');
    assert.equal(hit.target, 'B站');
    assert.match(hit.row.text, /主人纠偏/);
    assert.equal(hit.row.salience, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OBSERVE_SOURCES：四个来源闭集', () => {
  assert.deepEqual([...OBSERVE_SOURCES], ['chat', 'emotion', 'activity', 'note']);
});

test('createEmotionBridge（P3）：没接 fetchEmotions 就惰性，不写观察', () => {
  let wrote = 0;
  const observe = { append: () => { wrote++; return { ok: true, row: {} }; } };
  const bridge = createEmotionBridge({ observe });
  const r = bridge.collect();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-wired');
  assert.equal(wrote, 0, '没接线绝不写观察——宁缺毋假');
});

test('createEmotionBridge（P3）：情绪条目写成 source=emotion、默认 tag 牵挂', () => {
  const got = [];
  const observe = { append: (x) => { got.push(x); return { ok: true, row: x }; } };
  const bridge = createEmotionBridge({
    observe,
    fetchEmotions: () => [
      { text: '心情不错，想找人说话', salience: 0.7, ts: 1000 },
      { text: '', tag: '忽略' }, // 空文本跳过
    ],
  });
  const r = bridge.collect(2000);
  assert.equal(r.ok, true);
  assert.equal(r.written.length, 1);
  assert.equal(got[0].source, 'emotion');
  assert.equal(got[0].tag, '牵挂');
  assert.equal(got[0].salience, 0.7);
  assert.equal(got[0].ts, 1000);
});

test('createEmotionBridge：fetch 抛错如实返回，不写观察', () => {
  const bridge = createEmotionBridge({
    observe: { append: () => ({ ok: true, row: {} }) },
    fetchEmotions: () => { throw new Error('mood 读不了'); },
  });
  assert.deepEqual(bridge.collect(), { ok: false, reason: 'fetch-failed' });
});
