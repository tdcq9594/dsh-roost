// 5.13 单聊「正在输入」：只对私聊、不走 outbound、失败不抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createRoostHostChannel } from '../src/channel.js';

test('sendTyping：私聊走 msg.typing，群聊直接拒绝', async () => {
  const rpc = [];
  const ch = createRoostHostChannel({
    host: { rpc: async (name, body) => { rpc.push({ name, body }); return { ok: true, id: 't1' }; } },
    log: () => {},
    markdownEnabled: true,
  });
  const r = await ch.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.equal(r.ok, true);
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].name, 'msg.typing', '要走专门的 typing 方法，不能混进 msg.send');
  assert.equal(rpc[0].body.chatId, 'OPENID_A');

  const g = await ch.sendTyping({ scene: 'group', target: 'GROUP_X' });
  assert.equal(g.ok, false);
  assert.match(g.message, /群聊/);
  assert.equal(rpc.length, 1, '群聊不该发出去');

  const empty = await ch.sendTyping({ scene: 'c2c', target: '' });
  assert.equal(empty.ok, false);
});

test('sendTyping：协议侧抛错时返回 ok:false，不冒泡', async () => {
  const ch = createRoostHostChannel({
    host: { rpc: async () => { throw new Error('宿主没这个能力'); } },
    log: () => {},
    markdownEnabled: true,
  });
  const r = await ch.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.equal(r.ok, false);
  assert.match(r.message, /宿主没这个能力/);
});

test('配置与节流：默认开、每会话 60 秒一次、只在单聊', async () => {
  const { DEFAULTS } = await import('../src/config.js');
  assert.equal(DEFAULTS.chat?.typing, true, '默认开');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.ok(host.includes('TYPING_EVERY_MS = 60_000'), '要有 60 秒节流');
  assert.ok(host.includes("chat.kind === 'c2c' && cfg.chat?.typing !== false"), '只对私聊且可关');
  assert.ok(host.includes('sendTyping?.({ scene: \'c2c\''), '回合开始要真的调用');
  /** 失败不能影响回复：调用处必须吞异常 */
  assert.ok(/sendTyping\?\.\(\{[^}]*\}\)\?\.catch\?\.\(\(\) => \{\}\)/.test(host), '要 catch 掉失败');
});
