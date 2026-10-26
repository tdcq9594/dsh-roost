// dsh-roost 的测试
//
// 只测「不依赖 DSH 也能测」的部分：整形、会话映射、HTTP 契约、一轮的状态机。
// 真正的联调（DSH 会话、agent）得在真环境里跑，这里用假 agent 顶。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderInbound, chatOf } from '../src/inbound.js';
import { createSessions } from '../src/sessions.js';
import { createInboundServer, postReply } from '../src/server.js';
import { createTurnRunner, textOf } from '../src/turn.js';
import { DEFAULTS, publicConfig } from '../src/config.js';
import { bucketOf, modeFor, describeSpeaker, rulesFor } from '../src/permissions.js';
import { createSetup } from '../src/setup.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-roost-'));

/* ---------------- 整形 ---------------- */

test('整形：优先用插件给的 rendered', () => {
  const p = { text: '看图', rendered: '看图\n（语音，转成文字是：你好）', attachments: [{ type: 'voice', asrText: '你好' }] };
  assert.equal(renderInbound(p), '看图\n（语音，转成文字是：你好）');
});

test('整形：没有 rendered 时自己拼语音 ASR', () => {
  const p = { text: '', attachments: [{ type: 'voice', asrText: '今天几号' }] };
  assert.match(renderInbound(p), /今天几号/);
});

test('整形：引用、合并转发、卡片都带上', () => {
  const p = {
    text: '这个',
    quoted: '上一句',
    elements: [
      { type: 'chatRecord', content: 'A: 1' },
      { type: 'ark', ark: { title: '一个视频' } },
    ],
  };
  const out = renderInbound(p);
  assert.match(out, /上一句/);
  assert.match(out, /A: 1/);
  assert.match(out, /一个视频/);
});

test('整形：全空也有兜底文案', () => {
  assert.ok(renderInbound({}).length > 0);
});

test('会话标识：群和私聊分开，preset 跟着走', () => {
  const g = chatOf({ chat: { kind: 'group', chatId: 'g1', groupId: 'g1' } });
  assert.equal(g.preset, 'roost-social');
  const c = chatOf({ chat: { kind: 'c2c', chatId: 'u1' } });
  assert.equal(c.preset, 'roost-private');
});

/* ---------------- 会话映射 ---------------- */

test('会话映射：存了能读出来，重启也还在', () => {
  const dir = tmp();
  const a = createSessions({ dataDir: dir });
  a.set('g1', 'sess-1', { preset: 'roost-social', title: '测试群' });
  assert.equal(a.get('g1'), 'sess-1');

  const b = createSessions({ dataDir: dir }); // 模拟重启
  assert.equal(b.get('g1'), 'sess-1');
  assert.equal(b.size, 1);
});

test('会话映射：清掉之后下一句会新建', () => {
  const s = createSessions({ dataDir: tmp() });
  s.set('g1', 'sess-1');
  s.remove('g1');
  assert.equal(s.get('g1'), '');
});

test('会话映射：能按会话 id 批量清', () => {
  const s = createSessions({ dataDir: tmp() });
  s.set('g1', 'sess-1');
  s.set('g2', 'sess-1');
  s.set('g3', 'sess-2');
  assert.equal(s.forgetSession('sess-1'), 2);
  assert.equal(s.get('g3'), 'sess-2');
});

/* ---------------- HTTP 契约 ---------------- */

test('inbound：收到就立刻 200，不等处理完', async () => {
  const got = [];
  const srv = createInboundServer({
    port: 17399,
    onInbound: (p) => got.push(p), // 故意不同步等待
    log: () => {},
  });

  try {
    const res = await fetch('http://127.0.0.1:17399/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e1', chat: { chatId: 'g1' }, reply: { url: 'http://127.0.0.1:1/x' } }),
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'e1');
  } finally {
    srv.close();
  }
});

test('inbound：缺 id 或 reply.url 返回 400', async () => {
  const srv = createInboundServer({ port: 17398, onInbound: () => {}, log: () => {} });
  try {
    const res = await fetch('http://127.0.0.1:17398/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e1' }),
    });
    assert.equal(res.status, 400);
  } finally {
    srv.close();
  }
});

test('inbound：配了密钥就必须带对', async () => {
  const srv = createInboundServer({ port: 17397, token: 'k', onInbound: () => {}, log: () => {} });
  try {
    const body = JSON.stringify({ id: 'e1', chat: { chatId: 'g1' }, reply: { url: 'http://127.0.0.1:1/x' } });

    const bad = await fetch('http://127.0.0.1:17397/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(bad.status, 401);

    const good = await fetch('http://127.0.0.1:17397/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roost-token': 'k' },
      body,
    });
    assert.equal(good.status, 200);
  } finally {
    srv.close();
  }
});

test('健康检查', async () => {
  const srv = createInboundServer({ port: 17396, onInbound: () => {}, log: () => {} });
  try {
    const res = await fetch('http://127.0.0.1:17396/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).plugin, 'dsh-roost');
  } finally {
    srv.close();
  }
});

test('回话：拒绝非本机地址（防 SSRF）', async () => {
  await assert.rejects(
    () => postReply({ id: 'e1', reply: { url: 'http://evil.example.com/reply', token: 't' } }, 'hi'),
    /不在本机/,
  );
});

test('回话：缺地址或令牌时说清楚', async () => {
  await assert.rejects(() => postReply({ id: 'e1' }, 'hi'), /没有回话地址/);
  await assert.rejects(() => postReply({ id: 'e1', reply: { url: 'http://127.0.0.1:1/x' } }, 'hi'), /没有回话令牌/);
});

/* ---------------- 一轮的状态机 ---------------- */

test('取文本：只拼 text 块', () => {
  const msg = { content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: '世界' }] };
  assert.equal(textOf(msg), '你好\n世界');
  assert.equal(textOf(null), '');
});

/** 造一个假的 ctx + agent，模拟 DSH 的事件流 */
function fakeDsh() {
  const handlers = [];
  const ctx = {
    on: (name, fn) => {
      handlers.push({ name, fn });
      return () => {};
    },
    sessions: { flush: async () => {} },
  };
  const emit = (session, event) => {
    for (const h of handlers) if (h.name === 'session/event') h.fn(session, event);
  };
  return { ctx, emit };
}

test('跑一轮：拿到 assistant/message 的文本', async () => {
  const { ctx, emit } = fakeDsh();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 's1' };
  const agent = { session, followup: async () => {} };

  const p = runner.run(agent, '你好');
  // 投递后才会有事件，所以等一拍
  await new Promise((r) => setTimeout(r, 10));
  emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '在呢' }] } } });
  emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal(await p, '在呢');
  runner.dispose();
});

test('跑一轮：多段 assistant/message 取最后一次', async () => {
  const { ctx, emit } = fakeDsh();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 's2' };
  const agent = { session, followup: async () => {} };

  const p = runner.run(agent, '查一下');
  await new Promise((r) => setTimeout(r, 10));
  emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '我查查' }] } } });
  emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '查到了，是 42' }] } } });
  emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal(await p, '查到了，是 42');
  runner.dispose();
});

test('跑一轮：没正常结束要报错', async () => {
  const { ctx, emit } = fakeDsh();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 's3' };
  const agent = { session, followup: async () => {} };

  const p = runner.run(agent, 'x');
  await new Promise((r) => setTimeout(r, 10));
  emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });

  await assert.rejects(() => p, /没正常结束/);
  runner.dispose();
});

test('跑一轮：同一会话不许并发', async () => {
  const { ctx } = fakeDsh();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 's4' };
  const agent = { session, followup: async () => {} };

  runner.run(agent, 'a').catch(() => {});
  await assert.rejects(() => runner.run(agent, 'b'), /上一轮还没结束/);
  runner.dispose();
});

/* ---------------- 权限 ---------------- */

test('权限：优先用插件给的 bucket', () => {
  assert.equal(bucketOf({ sender: { bucket: 'owner' } }), 'owner');
  assert.equal(bucketOf({ sender: { bucket: 'admin' } }), 'admin');
  assert.equal(bucketOf({ sender: { bucket: 'member' } }), 'member');
});

test('权限：只给数字等级时按 0/1 分档', () => {
  assert.equal(bucketOf({ sender: { level: 0 } }), 'owner');
  assert.equal(bucketOf({ sender: { level: 1 } }), 'admin');
  assert.equal(bucketOf({ sender: { level: 2 } }), 'member');
  assert.equal(bucketOf({ sender: { level: 99 } }), 'member');
});

test('权限：拿不到信息就是 unknown（兜底）', () => {
  assert.equal(bucketOf({}), 'unknown');
  assert.equal(bucketOf({ sender: {} }), 'unknown');
  assert.equal(bucketOf({ sender: { bucket: '随便写的' } }), 'unknown');
  assert.equal(bucketOf({ sender: { level: 'abc' } }), 'unknown');
});

test('权限：unknown 默认只给聊天', () => {
  const perms = { owner: 'all', admin: 'all', member: 'all', unknown: 'chat' };
  assert.equal(modeFor('owner', perms), 'all');
  assert.equal(modeFor('member', perms), 'all');
  assert.equal(modeFor('unknown', perms), 'chat');
});

test('权限：没配或配错一律按最严处理', () => {
  assert.equal(modeFor('member', {}), 'chat');
  assert.equal(modeFor('member', { member: '随便' }), 'chat');
  assert.equal(modeFor('owner', undefined), 'chat');
});

test('权限：告诉 AI 谁在说话', () => {
  const line = describeSpeaker({ sender: { name: '小明' } }, 'member');
  assert.match(line, /小明/);
  assert.match(line, /普通成员/);

  const unknown = describeSpeaker({ sender: {} }, 'unknown');
  assert.match(unknown, /身份不明/);
});

test('权限：普通成员和身份不明的硬规则都提到不跑命令/不读文件', () => {
  assert.match(rulesFor('member'), /不要执行任何会改动这台机器的操作/);
  assert.match(rulesFor('unknown'), /按最低权限对待/);
  assert.match(rulesFor('unknown'), /不调用任何本地工具/);
  assert.match(rulesFor('owner'), /可以正常使用工具/);
});

test('权限：默认配置里 unknown 是 chat', () => {
  assert.equal(DEFAULTS.permissions.unknown, 'chat');
  assert.equal(DEFAULTS.permissions.owner, 'all');
});

/* ---------------- 一键流程 ---------------- */

test('一键：空目录检测出「什么都没装」', async () => {
  const dir = tmp();
  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir, version: 'v0.8.1' }, server: { port: 17321 } }),
    dataDir: dir,
  });
  const st = await s.detect();
  assert.equal(st.installed, false);
  assert.equal(st.running, false);
  assert.equal(st.hasBot, false);
  assert.equal(st.pluginInstalled, false);
  assert.equal(st.pluginConfigured, false);
});

test('一键：写了机器人配置之后，检测立刻看得到', async () => {
  const dir = tmp();
  // 先钉一个不会被占用的端口，免得 detect 打到本机真的 Roost
  mkdirSync(join(dir, 'config', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'config', 'bot.json'), JSON.stringify({ webui: { port: 59999 } }), 'utf8');

  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir, version: 'v0.8.1' }, server: { port: 17321 } }),
    dataDir: dir,
  });

  s.createBot({ name: 'main', appId: '102000000', appSecret: 'sec' });

  const st = await s.detect();
  assert.equal(st.hasBot, true);
  assert.equal(st.bots[0].appId, '102000000');
  // 已有的端口不能被覆盖
  assert.equal(st.port, 59999);
});

test('一键：AppID / AppSecret 缺一个就报错', () => {
  const dir = tmp();
  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir }, server: { port: 17321 } }),
    dataDir: dir,
  });
  assert.throws(() => s.createBot({ name: 'main', appId: 'x' }), /都要填/);
});

test('一键：WebUI 地址带上面板密钥', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'bot.json'),
    JSON.stringify({ webui: { port: 8090, accessKey: 'k1' } }),
    'utf8',
  );
  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir }, server: { port: 17321 } }),
    dataDir: dir,
  });
  assert.equal(s.webuiUrl(), 'http://127.0.0.1:8090/?key=k1');
});

test('一键：绑定已有安装（目录里有 src/main.js 才算）', () => {
  const dir = tmp();
  const roost = tmp();
  mkdirSync(join(roost, 'src'), { recursive: true });
  writeFileSync(join(roost, 'src', 'main.js'), '// fake', 'utf8');

  let cfg = { setup: { roostDir: '', version: 'v0.8.1' }, server: { port: 17321 } };
  const s = createSetup({ cfgOf: () => cfg, setCfg: (p) => (cfg = { ...cfg, ...p }), dataDir: dir });

  const r = s.setDir(roost);
  assert.equal(r.ok, true);
  assert.equal(cfg.setup.roostDir, roost);
});

test('一键：绑定的目录不对要明确报错', () => {
  const dir = tmp();
  let cfg = { setup: { roostDir: '' }, server: { port: 17321 } };
  const s = createSetup({ cfgOf: () => cfg, setCfg: (p) => (cfg = { ...cfg, ...p }), dataDir: dir });

  assert.throws(() => s.setDir(dir), /没找到 src\/main\.js/);
  assert.throws(() => s.setDir(''), /不能为空/);
});

test('一键：绑定时去掉尾斜杠和引号（从资源管理器复制来的路径）', () => {
  const dir = tmp();
  const roost = tmp();
  mkdirSync(join(roost, 'src'), { recursive: true });
  writeFileSync(join(roost, 'src', 'main.js'), '// fake', 'utf8');

  let cfg = { setup: { roostDir: '' }, server: { port: 17321 } };
  const s = createSetup({ cfgOf: () => cfg, setCfg: (p) => (cfg = { ...cfg, ...p }), dataDir: dir });

  s.setDir(`"${roost}/"`);
  assert.equal(cfg.setup.roostDir.replace(/\\/g, '/'), roost.replace(/\\/g, '/'));
});

/* ---------------- 配置 ---------------- */

test('配置：密钥打码，但能看出有没有设', () => {
  const a = publicConfig({ ...DEFAULTS, server: { port: 1, token: 'secret' } });
  assert.equal(a.server.token, '******');
  assert.equal(a.tokenSet, true);

  const b = publicConfig({ ...DEFAULTS, server: { port: 1, token: '' } });
  assert.equal(b.tokenSet, false);
});

test('配置：默认端口跟 ai-chat 的默认地址对上', () => {
  assert.equal(DEFAULTS.server.port, 17321);
});
