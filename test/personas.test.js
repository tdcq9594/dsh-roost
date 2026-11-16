import test from 'node:test';
import assert from 'node:assert/strict';

import { pickPersonaId } from '../src/personas.js';
/**
 * 单人专属人设的优先级。
 *
 * 用户需求原话：「想给单人设置专属人设」。原来的粒度只有 `byChat`（一个会话
 * 一个档），群里没法给某个人单独换；`bySender` 就是补这一层。
 *
 * 优先级：当轮 `<<persona:>>` > 按人 > 按会话 > 全局。
 * 错了不会报错，只会「人格不对」——所以这里把每一层单独钉一遍。
 */
test('pickPersonaId：四层优先级', () => {
  const persona = {
    current: 'default',
    byChat: { g1: 'chat-a' },
    bySender: { u1: 'mine' },
  };

  assert.equal(pickPersonaId({ persona, chatId: 'g1', senderId: 'u1' }), 'mine', '按人压过按会话');
  assert.equal(pickPersonaId({ persona, chatId: 'g1', senderId: 'u2' }), 'chat-a', '别人走会话那档');
  assert.equal(pickPersonaId({ persona, chatId: 'g9', senderId: 'u1' }), 'mine', '按人不分会话');
  assert.equal(pickPersonaId({ persona, chatId: 'g9', senderId: 'u2' }), 'default', '都没有就全局');
  assert.equal(
    pickPersonaId({ persona, chatId: 'g1', senderId: 'u1', runtimePick: 'tmp' }),
    'tmp',
    '当轮显式切换最优先（它只活到重启）',
  );
});

test('pickPersonaId：脏配置不崩、空发送者不误命中', () => {
  assert.equal(pickPersonaId({}), 'default');
  assert.equal(pickPersonaId({ persona: null, chatId: 'x' }), 'default');
  assert.equal(pickPersonaId({ persona: { byChat: { x: 'p' } }, chatId: 'x' }), 'p');
  /** 主动搭话那种没有真人的轮次：senderId 空，不能拿空串去查 bySender */
  assert.equal(
    pickPersonaId({ persona: { bySender: { '': 'oops' }, current: 'default' }, senderId: '' }),
    'default',
  );
});
