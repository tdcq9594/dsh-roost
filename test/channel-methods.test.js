/**
 * 频道方法兜底名单的分组契约。
 *
 * 背景：`/channel/methods` 在框架不带 `group` 时走本地兜底名单。这里锁两件事：
 *
 * 1. **兜底也要给出真实分组**（2026-11-15 之前统一盖成「频道（本地兜底）」，
 *    而面板按 `=== '频道'` / `startsWith('频道·')` 过滤，两边对不上 —— 四个
 *    接口页全空，还误报「框架没提供频道方法」）。
 * 2. **每个方法都落在面板那四段里的恰好一段**，不会有方法在面板上找不到入口。
 *
 * 下面这份分组表是**故意抄**前端 `CH_SECTIONS` 的：它锁的是跨端契约，
 * 谁改了另一边这条就会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHANNEL_QQ_FALLBACK } from '../src/host.js';

/** 与 client/client.js 的 CH_SECTIONS 一致 */
const SECTIONS = [
  { id: 'channels', groups: ['频道', '频道·子频道'] },
  { id: 'messages', groups: ['频道·消息', '频道·私信', '频道·表情'] },
  { id: 'content', groups: ['频道·公告', '频道·论坛', '频道·精华', '频道·日程', '频道·音频'] },
  { id: 'member', groups: ['频道·成员', '频道·身份组', '频道·权限', '频道·API权限'] },
];

/** 与前端 ChannelApiTab 的 sectionOf 同一套判定：最长前缀优先 */
function sectionOf(group) {
  const s = String(group || '');
  let best = null;
  for (const sec of SECTIONS) {
    for (const p of sec.groups) {
      if (s === p || s.startsWith(`${p}·`)) {
        if (!best || p.length > best.len) best = { sec, len: p.length };
      }
    }
  }
  return best ? best.sec : null;
}

test('兜底名单是 Map，且每个方法都带真实分组', () => {
  assert.ok(CHANNEL_QQ_FALLBACK instanceof Map, '必须是 Map<method, group>，Set 没法带分组');
  assert.ok(CHANNEL_QQ_FALLBACK.size >= 40, `方法太少（${CHANNEL_QQ_FALLBACK.size}），名单可能被截断`);
  for (const [method, group] of CHANNEL_QQ_FALLBACK) {
    assert.equal(typeof method, 'string');
    assert.ok(method.length > 0, '方法名不能为空');
    assert.equal(typeof group, 'string', `${method} 的分组必须是字符串`);
    assert.ok(group.startsWith('频道'), `${method} 的分组「${group}」必须以「频道」开头，否则面板过滤不到`);
  }
});

test('不再有「频道（本地兜底）」这种盖掉真实分组的写法', () => {
  for (const [method, group] of CHANNEL_QQ_FALLBACK) {
    assert.notEqual(group, '频道（本地兜底）', `${method} 还在用旧口径，面板会把它过滤掉`);
  }
});

test('每个方法都能被面板四段中的一段认领，且只认领一次', () => {
  const missing = [];
  for (const [method, group] of CHANNEL_QQ_FALLBACK) {
    if (!sectionOf(group)) missing.push(`${method}（${group}）`);
  }
  assert.deepEqual(missing, [], `这些方法在面板上找不到入口：${missing.join('、')}`);
});

test('最长前缀优先：子分组不会被基础分组吞掉', () => {
  /* 这条是回归闸：原来靠 startsWith('频道·') 判定，结果「频道」段
     把「频道·消息」等全部吞进来，第一页列全部、后三页重复列。 */
  assert.equal(sectionOf('频道').id, 'channels');
  assert.equal(sectionOf('频道·子频道').id, 'channels');
  assert.equal(sectionOf('频道·消息').id, 'messages');
  assert.equal(sectionOf('频道·私信').id, 'messages');
  assert.equal(sectionOf('频道·公告').id, 'content');
  assert.equal(sectionOf('频道·身份组').id, 'member');
  /* 框架将来加更深的分组，也要归到最近的那一段 */
  assert.equal(sectionOf('频道·消息·引用').id, 'messages');
});

test('四段都有方法，不会出现空段', () => {
  const counts = SECTIONS.map((s) => ({
    id: s.id,
    n: [...CHANNEL_QQ_FALLBACK.values()].filter((g) => sectionOf(g)?.id === s.id).length,
  }));
  for (const c of counts) {
    assert.ok(c.n > 0, `「${c.id}」段在兜底模式下会是空的`);
  }
});

test('关键方法没从名单里掉出去', () => {
  for (const k of [
    'getGuildChannels', 'createGuildChannel', 'deleteChannel',
    'sendChannelMessage', 'sendDmMessage', 'createDms',
    'postChannelAnnounces', 'getThreadsList', 'getPinsMessage',
    'getGuildMembers', 'getGuildRoles', 'putChannelPermissions',
  ]) {
    assert.ok(CHANNEL_QQ_FALLBACK.has(k), `兜底名单缺 ${k}`);
  }
});
