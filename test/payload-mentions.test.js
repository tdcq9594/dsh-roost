import test from 'node:test';
import assert from 'node:assert/strict';

import { describeMentions, buildRendered } from '../src/roost-payload.js';

/**
 * @ 对象归属。
 *
 * 2026-11-17 核验：框架 `serialize.js` 一直有 `mentions`，但这边**从没接**——
 * 模型看不到「这条 @ 了谁」，于是把「@小明 你帮我看看」当成叫它自己。
 * aurabot 的 `fix(#475)` 修的是同一件事。
 */

test('describeMentions：有 @ 才写，名字去重', () => {
  assert.deepEqual(describeMentions({ mentions: [{ username: '小明' }, { username: '小红' }] }),
    ['（这条 @ 了：小明、小红）']);
  assert.deepEqual(describeMentions({ mentions: [] }), []);
  assert.deepEqual(describeMentions({}), [], '老框架没有这个字段也不能炸');
  assert.deepEqual(describeMentions({ mentions: [{ username: '小明' }, { username: '小明' }] }),
    ['（这条 @ 了：小明）'], '同一个人 @ 两次只写一遍');
  /** 名字缺失时退回 id，总比什么都不说强 */
  assert.deepEqual(describeMentions({ mentions: [{ id: '123456' }] }), ['（这条 @ 了：123456）']);
});

test('buildRendered：@ 信息要出现在给模型看的正文里', () => {
  const evt = {
    mentions: [{ username: '小明' }],
    sender: { openid: 'u1', name: '小红' },
  };
  const out = buildRendered(evt, '@小明 你帮我看看这个')
  assert.match(out, /你帮我看看这个/)
  assert.match(out, /@ 了：小明/, '模型必须知道这句话是叫小明的，不是叫它的')
  /** @ 标注要跟在正文后面，不能被附件描述挤到最后 */
  assert.ok(out.indexOf('@ 了') < out.indexOf('（发来') || out.indexOf('（发来') < 0)
})

test('buildRendered：没有 @ 时不加噪音', () => {
  const out = buildRendered({ sender: { openid: 'u1', name: '小红' } }, '普通一句')
  assert.equal(out, '普通一句')
  assert.doesNotMatch(out, /@ 了/)
})
