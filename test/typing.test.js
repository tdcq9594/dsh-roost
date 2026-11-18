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

/**
 * 「正在输入」也不经过 `send`，所以总开关和试运行必须各判一次
 * （2026-11-19 自检）。正常路径上 `judge()` 已经把总开关关着的消息挡住，
 * 但留一个不判据的 rpc 入口迟早被别处调用——`sendFile` / `sendVoice` 就是实例。
 */
test('sendTyping：总开关关着不发，试运行也不发（一条 rpc 都不打）', async () => {
  const rpc = [];
  const host = { rpc: async (name) => { rpc.push(name); return { ok: true }; } };

  const off = createRoostHostChannel({
    host, log: () => {}, markdownEnabled: true, masterOffOf: () => true,
  });
  const r1 = await off.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'disabled');
  assert.equal(rpc.length, 0, '总开关关着不能真打 msg.typing');

  const dry = createRoostHostChannel({
    host, log: () => {}, markdownEnabled: true, dryRunOf: () => true,
  });
  const r2 = await dry.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.equal(r2.ok, true, '试运行不是失败');
  assert.equal(r2.dryRun, true);
  assert.equal(rpc.length, 0, '试运行也不该让她在对方那里闪一下「正在输入」');

  /** 判据是热读的：开关一开立刻恢复 */
  let isOffNow = true;
  const live = createRoostHostChannel({
    host, log: () => {}, markdownEnabled: true, masterOffOf: () => isOffNow,
  });
  await live.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.equal(rpc.length, 0);
  isOffNow = false;
  await live.sendTyping({ scene: 'c2c', target: 'OPENID_A' });
  assert.deepEqual(rpc, ['msg.typing'], '打开后要照常发');
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
