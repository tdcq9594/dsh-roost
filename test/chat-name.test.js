// 会话标题：什么时候该改、改成什么。
//
// 这段逻辑原来埋在 host.js 的闭包里，**零测试**——上一轮修「不降级」「不抖」
// 之后测试仍然全绿，因为根本没有测试碰它。抽成纯函数就是为了能被这里钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SENTINEL_NAMES,
  CONTINUED_SUFFIX,
  realChatName,
  sessionTitle,
  nextTitle,
  isPlaceholderTitle,
  isSentinelTitle,
  withContinued,
} from '../src/chat-name.js';

const G = (name, chatId = 'A1B2C3D4E5F6') => ({ kind: 'group', chatId, name });
const C2C = (name, chatId = 'A1B2C3D4E5F6') => ({ kind: 'c2c', chatId, name });

test('标题：有名字就用名字，没名字用「群/私聊 + 尾号」，不摆 openid', () => {
  assert.equal(sessionTitle(G('摸鱼群')), 'QQ · 摸鱼群');
  assert.equal(sessionTitle(G('')), 'QQ · 群 D4E5F6');
  assert.equal(sessionTitle(C2C('')), 'QQ · 私聊 D4E5F6');
  assert.equal(sessionTitle(G('  ')), 'QQ · 群 D4E5F6', '空白名字等于没名字');
});

test('标题：哨兵名不当名字，但「巩固」是正经名字要保留', () => {
  assert.equal(realChatName({ name: '主动搭话' }), '');
  assert.equal(realChatName({ name: '自测' }), '');
  assert.equal(realChatName({ name: '巩固' }), '巩固', '巩固是后台会话的真名，别过滤');
  assert.equal(sessionTitle(G('主动搭话')), 'QQ · 群 D4E5F6');
  assert.ok(!SENTINEL_NAMES.has('巩固'));
});

test('标题：已有真群名，这次没拿到名字 → 不降级', () => {
  const r = nextTitle(G(''), 'QQ · 真群名');
  assert.equal(r.rename, false, '不能把好标题换成占位符');
});

test('标题：已有真群名，这次是哨兵名（主动搭话/自测）→ 也不降级', () => {
  assert.equal(nextTitle(G('自测'), 'QQ · 真群名').rename, false);
  assert.equal(nextTitle(G('主动搭话'), 'QQ · 真群名').rename, false);
});

test('标题：占位符 / openid / 空标题 → 该改成真名字', () => {
  assert.equal(nextTitle(G('真群名'), 'QQ · 群 D4E5F6').rename, true);
  assert.equal(nextTitle(G('真群名'), 'QQ · A1B2C3D4E5F6').rename, true, '旧版把 openid 当标题');
  assert.equal(nextTitle(G('真群名'), '').rename, true);
  assert.equal(nextTitle(G('真群名'), 'QQ · 群 D4E5F6').want, 'QQ · 真群名');
});

test('标题：旧版裸昵称 + 这次有真名 → 修掉', () => {
  const r = nextTitle(G('真群名'), 'QQ · 张三');
  assert.equal(r.rename, true);
  assert.equal(r.want, 'QQ · 真群名');
});

test('标题：旧版裸昵称 + 这次仍没名字 → 故意不改（可能是用户手改的名字）', () => {
  assert.equal(nextTitle(G(''), 'QQ · 张三').rename, false);
});

test('标题：压缩续会话同名 → 不改，后缀保留', () => {
  const r = nextTitle(G('真群名'), `QQ · 真群名${CONTINUED_SUFFIX}`);
  assert.equal(r.rename, false);
  assert.equal(r.want, `QQ · 真群名${CONTINUED_SUFFIX}`);
});

test('标题：压缩续会话 + 群改名 → 改，但「（续）」要跟着走', () => {
  const r = nextTitle(G('新群名'), `QQ · 真群名${CONTINUED_SUFFIX}`);
  assert.equal(r.rename, true);
  assert.equal(r.want, `QQ · 新群名${CONTINUED_SUFFIX}`, '压缩标记不能被抹掉');
});

test('标题：哨兵标题（无续）要修掉', () => {
  assert.equal(nextTitle(G(''), 'QQ · 主动搭话').rename, true);
  assert.equal(isSentinelTitle('QQ · 主动搭话'), true);
  assert.equal(isSentinelTitle('QQ · 主动搭话（续）'), false, '带后缀的要靠 base 判断');
});

test('标题：哨兵标题（带续）也要修掉——以前判 old 不判 base，永远修不掉', () => {
  const r = nextTitle(G(''), `QQ · 主动搭话${CONTINUED_SUFFIX}`);
  assert.equal(r.rename, true);
  // 它确实是压缩出来的续会话，所以修成占位符后「（续）」要留着
  assert.equal(r.want, `QQ · 群 D4E5F6${CONTINUED_SUFFIX}`);
});

test('标题：chatId 为空时不能被 includes("") 误判', () => {
  // `''.includes` 恒真，旧实现会把「QQ · 真群名」当成「标题里含 openid」
  const r = nextTitle(G('', ''), 'QQ · 真群名');
  assert.equal(r.rename, false);
});

test('标题：占位符识别', () => {
  assert.equal(isPlaceholderTitle('QQ · 群 D4E5F6'), true);
  assert.equal(isPlaceholderTitle('QQ · 私聊 D4E5F6'), true);
  assert.equal(isPlaceholderTitle('QQ · 群 D4E5F6（续）'), false, '带后缀的不是占位符');
  assert.equal(isPlaceholderTitle('QQ · 摸鱼群'), false);
});

test('标题：群名本身以「（续）」结尾时不会叠成「（续）（续）」，而且会收敛', () => {
  const chat = G('摸鱼群（续）');
  const step1 = nextTitle(chat, '');
  assert.equal(step1.want, 'QQ · 摸鱼群（续）', '不能拼成两个后缀');
  const step2 = nextTitle(chat, step1.want);
  assert.equal(step2.rename, false, '第二条消息必须收敛，不能每条都 rename');
});

test('标题：不改的时候 want 原样返回旧标题（调用方不看 rename 也不会写错）', () => {
  const old = 'QQ · 真群名';
  const r = nextTitle(G(''), old);
  assert.equal(r.rename, false);
  assert.equal(r.want, old, 'rename=false 时 want 必须等于旧值');
});

test('withContinued：幂等，已带后缀不再拼', () => {
  assert.equal(withContinued('QQ · 摸鱼群'), 'QQ · 摸鱼群（续）');
  assert.equal(withContinued('QQ · 摸鱼群（续）'), 'QQ · 摸鱼群（续）');
});
