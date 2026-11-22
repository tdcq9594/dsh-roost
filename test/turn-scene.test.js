/**
 * 「按会话存场景」的不变量测试。
 *
 * 背景：场景 / facts /「刚才说到」这三段注入以前读全局 `lastScene`
 * （最后一个说话的会话），`handleTurn` 里的 `await` 会让两个会话的轮次交错，
 * 于是 A 群的注入里出现 B 群的内容。修法是按 chatId 各存一份。
 *
 * 这里锁住的正是那条不变量：**A 的写入永远不影响 A 读到的内容**。
 * 如果哪天有人把这个 Map 改回单个变量，第 1 条就会红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnScenes } from '../src/turn-scene.js';

test('两个会话各存各的：A 的写入不影响 A 读到的内容', () => {
  const t = createTurnScenes();
  t.set('groupA', { chatId: 'groupA', name: '甲群' });
  t.set('groupB', { chatId: 'groupB', name: '乙群' });

  assert.equal(t.get('groupA').name, '甲群');
  assert.equal(t.get('groupB').name, '乙群');
});

test('并发交错的真实顺序：A 先写、B 后写，A 读到的仍是 A', () => {
  /**
   * 复刻 handleTurn 的时序：
   *   A 进来到 lastScene 赋值 → await recallFor → B 进来覆盖 → A 恢复读注入段
   * 用 Map 之后，「B 的写入」落在 groupB 这个键上，A 那个键一个字节都没动。
   */
  const t = createTurnScenes();
  t.set('groupA', { chatId: 'groupA', name: '甲群', sender: '甲群的人' });
  // ← 这里在真实代码里是 await recallFor(...)
  t.set('groupB', { chatId: 'groupB', name: '乙群', sender: '乙群的人' });

  const a = t.get('groupA');
  assert.equal(a.name, '甲群');
  assert.equal(a.sender, '甲群的人', 'A 的场景不能被 B 覆盖');
});

test('同一会话再来一轮只换自己那条', () => {
  const t = createTurnScenes();
  t.set('g1', { chatId: 'g1', sender: '张三' });
  t.set('g2', { chatId: 'g2', sender: '李四' });
  t.set('g1', { chatId: 'g1', sender: '王五' });

  assert.equal(t.get('g1').sender, '王五');
  assert.equal(t.get('g2').sender, '李四', '换 g1 不能碰到 g2');
});

test('超上限时淘汰最久没写的那个，不是最新的', () => {
  const t = createTurnScenes(2);
  t.set('g1', { chatId: 'g1' });
  t.set('g2', { chatId: 'g2' });
  t.set('g1', { chatId: 'g1' }); // g1 变最新，该淘汰的是 g2
  t.set('g3', { chatId: 'g3' });

  assert.equal(t.size, 2);
  assert.equal(t.get('g2'), null, '最久没说话的 g2 被淘汰');
  assert.ok(t.get('g1'), '刚说过话的 g1 要留着');
  assert.ok(t.get('g3'));
});

test('空 chatId 不写入：否则所有会话又挤回同一个键', () => {
  const t = createTurnScenes();
  t.set('', { chatId: '', name: '来路不明' });
  t.set(null, {});
  t.set(undefined, {});

  assert.equal(t.size, 0, '空键必须不落地——那就是全局单变量换了个名字');
  assert.equal(t.get(''), null);
  assert.equal(t.latest(), null);
});

test('latest() 给面板兜底用，永远是最新写入的那条', () => {
  const t = createTurnScenes();
  assert.equal(t.latest(), null, '一条都没有时返回 null，不能编');
  t.set('g1', { chatId: 'g1' });
  t.set('g2', { chatId: 'g2' });
  assert.equal(t.latest().chatId, 'g2');
  t.set('g1', { chatId: 'g1' });
  assert.equal(t.latest().chatId, 'g1', '重新写入要把顺序往回挪');
});

test('没说过话的会话返回 null，调用方要能区分「没说过」和「说过但是空」', () => {
  const t = createTurnScenes();
  t.set('g1', { chatId: 'g1', name: '' });
  assert.equal(t.get('nobody'), null);
  assert.deepEqual(t.get('g1'), { chatId: 'g1', name: '' });
});

test('chatIds() 按写入顺序给，面板列会话用', () => {
  const t = createTurnScenes();
  t.set('g1', { chatId: 'g1' });
  t.set('g2', { chatId: 'g2' });
  assert.deepEqual(t.chatIds(), ['g1', 'g2']);
});
