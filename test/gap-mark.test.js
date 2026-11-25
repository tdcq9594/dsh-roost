/**
 * 「刚才说到」的水位线（`src/gap-mark.js`）。
 *
 * 这块只有三个要求，每条错了都会让注入块**不动**——正是 2026-11-25 那个
 * 「每次注入的账本都是同一段」的问题：
 *   · 露过的要记住（不记就永远算缺口，每轮重念）；
 *   · 只前移、不回退（回退一次，那段话又重念一遍）；
 *   · 写坏了不能影响回话（这块是增强，不是主链路）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGapMark } from '../src/gap-mark.js';

/** 每个用例一个临时目录：水位文件是共享状态，别让用例互相污染 */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gap-mark-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gapMark：没露过时是 0（全部算缺口）', () => {
  withDir((dir) => {
    const m = createGapMark({ file: join(dir, 'gap-mark.json') });
    assert.equal(m.get('g1'), 0);
    assert.equal(m.get(''), 0, '空会话不许编一个水位出来');
  });
});

test('gapMark：露过之后落盘，换个实例也读得到（跨重启）', () => {
  withDir((dir) => {
    const file = join(dir, 'gap-mark.json');
    createGapMark({ file }).set('g1', 2067);
    const again = createGapMark({ file });
    assert.equal(again.get('g1'), 2067);
    assert.equal(again.get('g2'), 0, '别的会话不受影响');
  });
});

test('gapMark：只前移，不回退', () => {
  withDir((dir) => {
    const m = createGapMark({ file: join(dir, 'gap-mark.json') });
    assert.equal(m.set('g1', 30), 30);
    assert.equal(m.set('g1', 12), 30, '往回退会让同一段话被重念一遍');
    assert.equal(m.get('g1'), 30);
    assert.equal(m.set('g1', 31), 31);
  });
});

test('gapMark：空会话 / 非法 seq 不写（别把文件写成 {"" : …}）', () => {
  withDir((dir) => {
    const file = join(dir, 'gap-mark.json');
    const m = createGapMark({ file });
    m.set('', 10);
    m.set('g1', 0);
    m.set('g1', Number.NaN);
    assert.equal(m.get('g1'), 0);
    assert.equal(m.get(''), 0);
  });
});

test('gapMark：文件坏了当没有，不抛', () => {
  withDir((dir) => {
    const file = join(dir, 'gap-mark.json');
    writeFileSync(file, '{ 这不是 json', 'utf8');
    const m = createGapMark({ file });
    assert.equal(m.get('g1'), 0, '读坏了就当没露过，最多多念一次');
    assert.equal(m.set('g1', 5), 5, '写还是要能写');
    assert.equal(createGapMark({ file }).get('g1'), 5);
  });
});

test('gapMark：会话太多时淘汰最久没写的，文件不无限长', () => {
  withDir((dir) => {
    const file = join(dir, 'gap-mark.json');
    const m = createGapMark({ file });
    for (let i = 0; i < 205; i += 1) m.set(`chat${i}`, i + 1);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const keys = Object.keys(saved.chats);
    assert.equal(keys.length, 200, '上限 200 个会话');
    assert.equal(m.get('chat204'), 205, '最近写的必须还在');
    assert.equal(m.get('chat0'), 0, '最久没写的被淘汰');
  });
});

test('gapMark：纯内存模式（不传文件）也能用，只是不落盘', () => {
  const m = createGapMark();
  assert.equal(m.set('g1', 7), 7);
  assert.equal(m.get('g1'), 7);
});

/**
 * 接线守卫：水位线要真被推进，否则整个机制等于没接。
 *
 * 真实注入走 `onInbound` 里那一行（`memoryDynamic(bucket, chat, text, true, text)`）；
 * 面板预览、诊断接口一律不带第四个参数。这条断言锁的是「真注入那一行」，
 * 哪天有人把它改回三参数（或忘了传），注入块立刻退回「同一段永远不刷新」。
 *
 * 第五个参数是正文：`recentSection` 拿它剔掉「本轮正文里已经有的」。
 * 写日记在拼注入之前，所以「日记最近几条」的第一条永远就是本轮这句；
 * 少了这个参数，注入块就跟下面的正文一字不差地重复一条（2026-11-25 实机）。
 */
test('接线：真注入那条路径必须带 commit=true（源码级，挡住回退）', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /const dyn = memoryDynamic\(bucket, chat, text, true, text\);/,
    'onInbound 里真注入那一行必须推进水位线，并把正文传进去剔重复',
  );
  /** 反过来：面板预览不许推进（`memoryDynamicText` 那条是给 /mind 的） */
  assert.match(
    src,
    /memoryDynamicText: memoryDynamic\(scene\?\.bucket \|\| lastBucket, panelChat, q\)/,
    '面板预览不能带 true，否则看一眼就把缺口吃掉',
  );
});
