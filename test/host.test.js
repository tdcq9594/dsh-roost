// dsh-roost 的测试
//
// 只测「不依赖 DSH 也能测」的部分：整形、会话映射、HTTP 契约、一轮的状态机。
// 真正的联调（DSH 会话、agent）得在真环境里跑，这里用假 agent 顶。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderInbound, chatOf } from '../src/inbound.js';
import { createSessions } from '../src/sessions.js';
import { createInboundServer, postReply } from '../src/server.js';
import { createTurnRunner, textOf } from '../src/turn.js';
import { DEFAULTS, publicConfig, saveConfig } from '../src/config.js';
import { bucketOf, bucketOfLevel, modeFor, describeSpeaker, rulesFor } from '../src/permissions.js';
import { createSetup } from '../src/setup.js';
import { createPersonas } from '../src/personas.js';
import { createStickers, tagsOf } from '../src/stickers.js';
import { createLease, candidates } from '../src/lease.js';
import {
  shouldFire,
  inAwakeWindow,
  scheduleNext,
  scheduleNextDay,
  silenceMsOf,
  createSpeakUp,
  DEFAULTS as SPEAK_DEFAULTS,
} from '../src/speakup.js';

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

test('TTS HTTP：能力查询返回公开状态，成功响应为二进制音频', async () => {
  const srv = createInboundServer({
    port: 17395,
    onInbound: () => {},
    onTts: async (text) => ({ audio: Buffer.from(`audio:${text}`), contentType: 'audio/mpeg' }),
    onTtsStatus: async () => ({ enabled: true, provider: 'openai', configured: true }),
    log: () => {},
  });
  try {
    const cap = await fetch('http://127.0.0.1:17395/capabilities');
    assert.deepEqual(await cap.json(), { ok: true, tts: { enabled: true, provider: 'openai', configured: true } });

    const res = await fetch('http://127.0.0.1:17395/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'audio:你好');
  } finally {
    srv.close();
  }
});

test('TTS HTTP：共享密钥保护 capabilities 与生成路由', async () => {
  const srv = createInboundServer({
    port: 17394, token: 'secret-token', onInbound: () => {},
    onTts: async () => ({ audio: Buffer.from('audio'), contentType: 'audio/mpeg' }),
    onTtsStatus: async () => ({ enabled: false, provider: 'openai', configured: false }),
    log: () => {},
  });
  try {
    const denied = await fetch('http://127.0.0.1:17394/capabilities');
    assert.equal(denied.status, 401);

    const res = await fetch('http://127.0.0.1:17394/tts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-roost-token': 'secret-token' },
      body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(res.status, 200);
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

/**
 * 这条是线上事故的回归测试。
 *
 * 曾经这里只把 `fetch` 的 `message`（永远是 `fetch failed`）抛出去，
 * 模型拿到「发送失败：fetch failed」只能瞎猜，实测它会跟用户说
 * 「网络没通，等会儿再试」——而真相是 ai-chat 的「面板地址」配错了、
 * 那个端口根本没人监听。用户等一辈子也不会好。
 *
 * 不能拿 1 号端口测：那在 fetch 的黑名单里，报的是 `bad port`，
 * 根本走不到连接这一步。要先占一个空闲端口再放掉，才是真的 ECONNREFUSED。
 */
async function deadPort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('回话：连不上时带出地址和 errno（不能只说 fetch failed）', async () => {
  const port = await deadPort();
  await assert.rejects(
    () => postReply({ id: 'e1', reply: { url: `http://127.0.0.1:${port}/reply`, token: 't' } }, 'hi'),
    (e) => {
      assert.match(e.message, new RegExp(`回话通道连不上（127\\.0\\.0\\.1:${port}）`));
      // 端口刚被放掉，正常一定是 ECONNREFUSED；别的 errno 也算连不上，不苛求
      assert.match(e.message, /ECONNREFUSED|EACCES|ECONNRESET|ETIMEDOUT/);
      assert.doesNotMatch(e.message, /：fetch failed$/, '不能把 fetch failed 当最终原因');
      return true;
    },
  );
});

test('回话：端口被 fetch 禁用时说明白（1 号端口走不到连接）', async () => {
  await assert.rejects(
    () => postReply({ id: 'e1', reply: { url: 'http://127.0.0.1:1/reply', token: 't' } }, 'hi'),
    /回话通道连不上（127\.0\.0\.1:1）.*端口被 fetch 规范禁用/,
  );
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

test('权限：数字等级按框架的 0/1/2/3 分档', () => {
  /**
   * 框架 `levels.js` 里 0 主人 / 1 管理员 / 2 群管 / 3 助手。
   *
   * 旧版本把 2 和 3 一起折进 member，这次展开成独立档位——
   * 主人特意配了 3 级的人，不该跟路人拿同一套工具。
   */
  assert.equal(bucketOf({ sender: { level: 0 } }), 'owner');
  assert.equal(bucketOf({ sender: { level: 1 } }), 'admin');
  assert.equal(bucketOf({ sender: { level: 2 } }), 'manager');
  assert.equal(bucketOf({ sender: { level: 3 } }), 'helper');
  // 9999（NO_PERM，从没配过权限的人）和插件区等级都是普通成员
  assert.equal(bucketOf({ sender: { level: 9999 } }), 'member');
  assert.equal(bucketOf({ sender: { level: 42 } }), 'member');
  // ai-chat 直接给 bucket 时以它为准
  assert.equal(bucketOf({ sender: { bucket: 'manager', level: 3 } }), 'manager');
});

test('权限：拿不到信息就是 unknown（兜底）', () => {
  assert.equal(bucketOf({}), 'unknown');
  assert.equal(bucketOf({ sender: {} }), 'unknown');
  assert.equal(bucketOf({ sender: { bucket: '随便写的' } }), 'unknown');
  assert.equal(bucketOf({ sender: { level: 'abc' } }), 'unknown');
});

test('权限：空的 / null 的等级不能被读成主人', () => {
  /**
   * `Number('')` 和 `Number(null)` 都是 **0**，而 0 是主人。
   * 「等级字段是空串」是最常见的「没填」状态，被读成最高权限，
   * 而这段代码的注释一直写着「拿不到权限就按最严处理」——方向正好相反。
   *
   * 老插件只给 `level` 不给 `bucket`，正是这条路径的主要使用者。
   */
  assert.equal(bucketOfLevel(''), '', '空串必须返回空串，由调用方兜到 unknown');
  assert.equal(bucketOfLevel(null), '');
  assert.equal(bucketOfLevel(undefined), '');
  assert.equal(bucketOfLevel(-1), '', '负数不是合法等级');
  assert.equal(bucketOfLevel(true), '', '布尔值不是等级');

  assert.equal(bucketOf({ sender: { level: '' } }), 'unknown');
  assert.equal(bucketOf({ sender: { level: null } }), 'unknown');
  assert.equal(bucketOf({ sender: { level: -1 } }), 'unknown');

  // 正常值不受影响
  assert.equal(bucketOfLevel(0), 'owner');
  assert.equal(bucketOfLevel('2'), 'manager');
  assert.equal(bucketOfLevel(3), 'helper');
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
  assert.equal(st.ownersConfigured, false, '没装 Roost 就没有主人');
});

test('一键：bot 配置里写了 owners，检测就报主人已设', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'config', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'config', 'bot.json'), JSON.stringify({ webui: { port: 59999 } }), 'utf8');
  // owners 是每个 bot 一份（config/bots/<id>.json），不是全局 bot.json
  writeFileSync(
    join(dir, 'config', 'bots', 'main.json'),
    JSON.stringify({ name: '主', appId: 'x', owners: ['OPENID_A', 'OPENID_B'] }),
    'utf8',
  );

  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir, version: 'v0.8.1' }, server: { port: 17321 } }),
    dataDir: dir,
  });
  const st = await s.detect();
  assert.equal(st.ownersConfigured, true, 'owners 非空就该报已设');
  assert.equal(st.ownerCount, 2);
  assert.equal(st.bots[0].ownerCount, 2);
});

test('一键：owners 是空数组时不算已设', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'config', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'config', 'bot.json'), JSON.stringify({ webui: { port: 59999 } }), 'utf8');
  writeFileSync(join(dir, 'config', 'bots', 'main.json'), JSON.stringify({ name: '主', appId: 'x', owners: [] }), 'utf8');

  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir, version: 'v0.8.1' }, server: { port: 17321 } }),
    dataDir: dir,
  });
  const st = await s.detect();
  assert.equal(st.ownersConfigured, false, 'owners 空 = 没设主人');
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

  await s.createBot({ name: 'main', appId: '102000000', appSecret: 'sec' });

  const st = await s.detect();
  assert.equal(st.hasBot, true);
  assert.equal(st.bots[0].appId, '102000000');
  // 已有的端口不能被覆盖
  assert.equal(st.port, 59999);
});

test('一键：AppID / AppSecret 缺一个就报错', async () => {
  const dir = tmp();
  const s = createSetup({
    cfgOf: () => ({ setup: { roostDir: dir }, server: { port: 17321 } }),
    dataDir: dir,
  });
  await assert.rejects(() => s.createBot({ name: 'main', appId: 'x' }), /都要填/);
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

/* ---------------- 人格库 ---------------- */

test('人格: 首次运行会把内置的种进去', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  const list = p.list();
  assert.ok(list.length >= 3, `只种了 ${list.length} 个`);
  assert.ok(list.some((x) => x.id === 'default'));
  assert.equal(list[0].id, 'default'); // default 排最前
});

test('人格: 解析 --- 头里的 name 和 tags', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  const one = p.read('terse');
  assert.equal(one.name, '惜字如金');
  assert.ok(one.tags.includes('极简'));
  assert.ok(one.body.length > 0);
  assert.ok(!one.body.includes('---'), '正文里不该残留 --- 头');
});

test('人格: 存了能读回来，也会出现在列表里', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  p.save('mine', '---\nname: 我的\n---\n你是我调过的人格。');
  const one = p.read('mine');
  assert.equal(one.name, '我的');
  assert.match(one.body, /调过/);
  assert.ok(p.list().some((x) => x.id === 'mine'));
});

test('人格: 按会话覆盖 > 全局当前 > default', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });

  const r1 = p.resolve('g1', { current: 'terse', byChat: { g1: 'snarky' } });
  assert.equal(r1.id, 'snarky', '按群指定的应该赢');

  const r2 = p.resolve('g2', { current: 'terse', byChat: { g1: 'snarky' } });
  assert.equal(r2.id, 'terse', '没指定的群用全局');

  const r3 = p.resolve('g3', {});
  assert.equal(r3.id, 'default', '都没配就 default');
});

test('人格: 指定的文件被删了要静默回退，不能让机器人失声', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  const r = p.resolve('g1', { current: 'not-exist' });
  assert.equal(r.id, 'default');
  assert.ok(r.body.length > 0);
});

test('人格: id 做安全过滤，挡路径穿越', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  // 现在直接拒绝（比以前静默改名更清楚）
  assert.throws(() => p.save('../../evil', 'x'), /不能有路径分隔符/);
  // 不能写到数据目录外面去
  assert.ok(!existsSync(join(dir, '..', '..', 'evil.md')));
  assert.ok(p.list().every((x) => !x.id.includes('/')));
});

test('人格: 默认人格不让删', () => {
  const dir = tmp();
  const p = createPersonas({ dataDir: dir });
  assert.throws(() => p.remove('default'), /不能删/);
});

/* ---------------- 表情包库 ---------------- */

test('表情: 文件名拆标签', () => {
  assert.deepEqual(tagsOf('开心_猫.png'), ['开心', '猫']);
  assert.deepEqual(tagsOf('无语-2.gif'), ['无语']);
  assert.deepEqual(tagsOf('a b.webp'), ['a', 'b']);
  assert.deepEqual(tagsOf('纯数字.png'), ['纯数字']);
});

test('表情: 只认图片，按文件名排序', () => {
  const dir = tmp();
  const s = createStickers({ dataDir: dir });
  const d = s.dir({});
  writeFileSync(join(d, 'b_开心.png'), 'x');
  writeFileSync(join(d, 'a_无语.gif'), 'x');
  writeFileSync(join(d, 'note.txt'), 'x');

  const list = s.list({});
  assert.equal(list.length, 2, 'txt 不该被算进来');
  assert.equal(list[0].file, 'a_无语.gif');
  assert.ok(list[0].path.endsWith('a_无语.gif'));
});

test('表情: 清单里给完整路径（不然模型拼不对）', () => {
  const dir = tmp();
  const s = createStickers({ dataDir: dir });
  const d = s.dir({});
  writeFileSync(join(d, '开心_猫.png'), 'x');

  const p = s.prompt({});
  assert.match(p, /表情包/);
  assert.match(p, /开心\/猫/); // 标签
  assert.ok(p.includes(join(d, '开心_猫.png')), '要给完整路径');
  assert.match(p, /<<image: /, '图文同条要教');
  assert.match(p, /<<image-alone: /, '单独发图也要教');
  assert.doesNotMatch(p, /!\[说明\]/, '标准 markdown 语法不该再教给模型');
});

test('表情: 没图 / 关掉时不注入', () => {
  const dir = tmp();
  const s = createStickers({ dataDir: dir });
  s.dir({});
  assert.equal(s.prompt({}), '');
  assert.equal(s.prompt({ enabled: false }), '');
});

test('表情: 能把「表情:标签」解析成路径', () => {
  const dir = tmp();
  const s = createStickers({ dataDir: dir });
  const d = s.dir({});
  writeFileSync(join(d, '开心_猫.png'), 'x');
  writeFileSync(join(d, '无语_人.png'), 'x');

  assert.ok(s.resolve({}, '表情:开心').endsWith('开心_猫.png'));
  assert.ok(s.resolve({}, '无语_人.png').endsWith('无语_人.png'));
  assert.equal(s.resolve({}, '表情:不存在'), null);
});

/* ---------------- 主动搭话 ---------------- */

const HOUR = 3600_000;

test('搭话: 免打扰时段判断（含跨零点）', () => {
  assert.equal(inAwakeWindow(9, 8, 23), true);
  assert.equal(inAwakeWindow(3, 8, 23), false);
  assert.equal(inAwakeWindow(23, 8, 23), false, '右边界不含');
  // 跨零点：22 点到次日 6 点
  assert.equal(inAwakeWindow(23, 22, 6), true);
  assert.equal(inAwakeWindow(2, 22, 6), true);
  assert.equal(inAwakeWindow(12, 22, 6), false);
  // from === to 表示全天
  assert.equal(inAwakeWindow(4, 0, 0), true);
});

test('搭话: 默认关着，没配 chatId 也不工作', () => {
  const now = Date.now();
  assert.equal(shouldFire({ nextAt: now - 1 }, SPEAK_DEFAULTS, now).fire, false);
  assert.match(shouldFire({ nextAt: now - 1 }, SPEAK_DEFAULTS, now).why, /没开/);

  const on = { ...SPEAK_DEFAULTS, enabled: true };
  assert.match(shouldFire({ nextAt: now - 1 }, on, now).why, /chatId/);
});

test('搭话: 主人刚说过话就不打扰', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1', minIntervalMinutes: 180 };
  const st = { nextAt: now - 1, lastOwnerAt: now - 60_000, day: new Date(now).toDateString(), todayCount: 0 };
  assert.equal(shouldFire(st, cfg, now).fire, false);
  assert.match(shouldFire(st, cfg, now).why, /刚说过话/);
});

test('搭话: 到点且主人冷场了才说', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1', minIntervalMinutes: 180 };
  const st = { nextAt: now - 1, lastOwnerAt: now - 5 * HOUR, day: new Date(now).toDateString(), todayCount: 0 };
  assert.equal(shouldFire(st, cfg, now).fire, true);
});

test('搭话: 每天有上限，跨天归零', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1', maxPerDay: 2 };
  const today = new Date(now).toDateString();

  const full = { nextAt: now - 1, lastOwnerAt: now - 5 * HOUR, day: today, todayCount: 2 };
  assert.equal(shouldFire(full, cfg, now).fire, false);
  assert.match(shouldFire(full, cfg, now).why, /已经说了 2 次/);

  // 昨天说了两次，今天重新开始
  const fresh = { nextAt: now - 1, lastOwnerAt: now - 5 * HOUR, day: 'Wed Jan 01 2025', todayCount: 2 };
  assert.equal(shouldFire(fresh, cfg, now).fire, true);
});

test('搭话: 半夜不吵人', () => {
  const night = new Date(2026, 9, 26, 3, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1' };
  const st = { nextAt: night - 1, lastOwnerAt: night - 9 * HOUR };
  assert.equal(shouldFire(st, cfg, night).fire, false);
  assert.match(shouldFire(st, cfg, night).why, /免打扰/);
});

test('搭话: 间隔是随机的，落在区间内', () => {
  const now = Date.now();
  const cfg = { ...SPEAK_DEFAULTS, minIntervalMinutes: 10, maxIntervalMinutes: 20 };
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const d = (scheduleNext(cfg, now) - now) / 60_000;
    assert.ok(d >= 10 && d <= 20, `间隔 ${d} 超出范围`);
    seen.add(Math.round(d));
  }
  assert.ok(seen.size > 1, '应该是随机的，不能每次都一样');
});

/**
 * 失败后的排期要按**原因**分开。
 *
 * 这是 2026-10-29 的修正：框架以前把「日额度用完」和「一分钟发太密」
 * 都报成 `quota`，调用方只能按最坏情况处理——一次分钟限流就让主动搭话
 * 停一整天。现在两者分开了，这里守住「分开了就要各用各的排期」。
 */
test('搭话: 额度用完推到明天，不是等几分钟再撞一次', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1', awakeFrom: 8 } }),
    generate: async () => '在吗',
    send: async () => ({ ok: false, code: 'quota', message: '今天的主动额度用完了' }),
  });
  const before = Date.now();
  const r = await sp.fire();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quota');

  const next = sp.state().nextAt;
  const target = new Date(before);
  target.setDate(target.getDate() + 1);
  target.setHours(8, 0, 0, 0);
  assert.ok(next >= target.getTime(), `应排到明天 8 点之后，实际 ${new Date(next)}`);
  assert.ok(next <= target.getTime() + 30 * 60_000, `不该超过明天 8:30，实际 ${new Date(next)}`);
});

test('搭话: 分钟限流只等一分钟', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    generate: async () => '在吗',
    send: async () => ({ ok: false, code: 'rate', message: '发得太密' }),
  });
  const before = Date.now();
  await sp.fire();
  const delta = sp.state().nextAt - before;
  assert.ok(delta >= 60_000 && delta < 61_000, `应等约一分钟，实际 ${delta}ms`);
});

test('搭话: 其它失败按随机间隔，不能误判成今天说满了', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1', minIntervalMinutes: 180, maxIntervalMinutes: 480 } }),
    generate: async () => '在吗',
    send: async () => ({ ok: false, code: 'offline', message: '没连上 QQ' }),
  });
  const before = Date.now();
  await sp.fire();
  const mins = (sp.state().nextAt - before) / 60_000;
  assert.ok(mins >= 180 && mins <= 480, `应落在随机间隔内，实际 ${mins} 分钟`);
});

/**
 * 「追问只追一次」。
 *
 * 这条从第 5 期就写在 `speakup.js` 的文件头里，但**只写了注释**：
 * `shouldFire()` 只看 `lastOwnerAt`，`lastBotAt` 记了没人读。
 * 后果是主人一直不回，她每 3–8 小时追一次，一路追满 `maxPerDay: 3`。
 */
test('搭话: 说了没回可以追一次，追完就闭嘴', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1', followUps: 1 };
  const base = {
    nextAt: now - 1, lastOwnerAt: now - 5 * HOUR,
    day: new Date(now).toDateString(), todayCount: 1,
  };

  const once = { ...base, unanswered: 1 };
  assert.equal(shouldFire(once, cfg, now).fire, true, '说了第 1 条没回，还允许追一次');

  const twice = { ...base, unanswered: 2 };
  assert.equal(shouldFire(twice, cfg, now).fire, false, '追过一次还没回，就不要再开口');
  assert.match(shouldFire(twice, cfg, now).why, /还没回/);
});

test('搭话: followUps=0 时说一次没回就不再开口', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1', followUps: 0 };
  const st = {
    nextAt: now - 1, lastOwnerAt: now - 5 * HOUR,
    day: new Date(now).toDateString(), todayCount: 1, unanswered: 1,
  };
  assert.equal(shouldFire(st, cfg, now).fire, false);
});

test('搭话: 主人回话之后，追问额度清零', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    generate: async () => '在吗',
    send: async () => ({ ok: true }),
  });
  await sp.fire();
  await sp.fire();
  assert.equal(sp.state().unanswered, 2, '连着两条都没被回');

  sp.noteOwner('u1');
  assert.equal(sp.state().unanswered, 0, '主人回来了，账要清零');
});

/**
 * 老状态文件里没有 `unanswered` 字段。
 *
 * 只写 `+1` 的话，升级后的第一次追问会被当成「第 1 条」，
 * 于是又能追满一整轮——等于这次修复对存量数据不生效。
 */
test('搭话: 老状态没有 unanswered 时，从 lastBotAt 补回来', async () => {
  const dir = tmp();
  writeFileSync(
    join(dir, 'speakup.json'),
    JSON.stringify({ nextAt: 0, todayCount: 0, day: '', lastOwnerAt: 0, lastBotAt: 1_000 }),
    'utf8',
  );
  const sp = createSpeakUp({
    dataDir: dir,
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    generate: async () => '在吗',
    send: async () => ({ ok: true }),
  });
  await sp.fire();
  assert.equal(sp.state().unanswered, 2, '上一条确实没被回，这次算第 2 条');
});

/**
 * 没配主人 openid 时手动触发，必须**在第一行就停**。
 *
 * 面板的「立刻走一次」直接调 `fire()`，绕过 `tick()` 的所有前置检查。
 * 以前这里没检查，于是：拿字面量 `'speakup'` 建了个假会话 → 跑了一轮模型
 * （真花钱）→ 读到所有会话的上下文（串场）→ 最后才报「缺 target」。
 */
test('搭话: 没配 chatId 时手动触发什么都不做', async () => {
  let spent = 0;
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: '' } }),
    generate: async () => {
      spent += 1;
      return '在吗';
    },
    send: async () => {
      spent += 1;
      return { ok: true };
    },
  });
  const r = await sp.fire('手动');
  assert.equal(r.ok, false);
  assert.match(r.why, /chatId|openid/);
  assert.equal(spent, 0, '一个字都不该花：不建会话、不调模型、不发消息');
  assert.equal(sp.state().lastBotAt, 0, '不该留下「说过话」的痕迹');
});

test('排期: 跨天排到清醒时段开始，且带 0–30 分钟随机', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  for (let i = 0; i < 20; i++) {
    const d = new Date(scheduleNextDay({ awakeFrom: 8 }, now));
    assert.equal(d.getDate(), 27, '必须是明天');
    assert.equal(d.getHours(), 8, '必须是清醒时段开始');
    assert.ok(d.getMinutes() < 30, `随机量不该超过 30 分钟，实际 ${d.getMinutes()} 分`);
  }
});

/**
 * `<<silence:2h>>`：她自己决定安静一阵子。
 *
 * 这里有个容易漏的地方——`fire()` 里那句 `raw.replace(/<<[^>]*>>/g, '')`
 * 会把**所有**标记一起抹平，所以时长必须**先提取再摘**。下面第一条就是守它的。
 */
test('搭话: 静默标记能解析出时长', () => {
  assert.equal(silenceMsOf('<<silence:2h>>'), 7_200_000);
  // 全角冒号：中文输入法下很常见，不认的话标记被兜底抹掉、静默却不会生效
  assert.equal(silenceMsOf('<<silence：2h>>'), 7_200_000);
  assert.equal(silenceMsOf('让我静静 <<silence:30>>'), 1_800_000); // 默认分钟
  assert.equal(silenceMsOf('<<silence:90s>>'), 90_000);
  assert.equal(silenceMsOf('没有标记'), 0);
  // 上限：不能变成永久静默
  assert.equal(silenceMsOf('<<silence:9999h>>'), 30 * 24 * 60 * 60_000);
});

test('搭话: 静默期间不再问要不要说话', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1' };
  const st = { nextAt: now - 1, lastOwnerAt: now - 5 * HOUR, silenceUntil: now + 2 * HOUR };
  const r = shouldFire(st, cfg, now);
  assert.equal(r.fire, false);
  assert.match(r.why, /安静/);
});

test('搭话: 静默到期自动恢复', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0).getTime();
  const cfg = { ...SPEAK_DEFAULTS, enabled: true, chatId: 'u1' };
  const st = { nextAt: now - 1, lastOwnerAt: now - 5 * HOUR, silenceUntil: now - 1 };
  assert.equal(shouldFire(st, cfg, now).fire, true);
});

test('搭话: 只要求安静时不占今日额度', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    generate: async () => '<<silence:2h>>',
    send: async () => ({ ok: true, silentOnly: true }),
  });
  const r = await sp.fire();
  assert.equal(r.ok, true);
  assert.equal(r.silent, true);
  assert.equal(sp.state().todayCount, 0, '她一个字都没说，不该占今天的开口额度');
  assert.ok(sp.state().silenceUntil > Date.now(), '静默要记下来，否则每分钟又问一遍');
  assert.ok(sp.state().nextAt >= sp.state().silenceUntil, '下一次问要排在静默之后');
});

test('搭话: 说完一句顺带要求安静', async () => {
  const sp = createSpeakUp({
    dataDir: tmp(),
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    generate: async () => '今天有点累 <<silence:3h>>',
    send: async () => ({ ok: true }),
  });
  const r = await sp.fire();
  assert.equal(r.ok, true);
  assert.equal(r.text, '今天有点累', '标记不能漏进消息');
  assert.ok(sp.state().silenceUntil > Date.now());
});

/* ---------------- 端口租约 ---------------- */

test('租约: 候选端口从 want 开始，上次的 actual 紧随其后', () => {
  const list = candidates(17321, 17323, 3);
  assert.equal(list[0], 17321, '配置的端口永远第一个试');
  assert.equal(list[1], 17323, 'want 被占时优先回上次那个（书签还能用）');
  assert.deepEqual(list.slice(2), [17322, 17324]);
  assert.equal(new Set(list).size, list.length, '不能有重复');
});

/**
 * 防棘轮：漂过一次不等于永久搬走。
 *
 * 曾经的实现把 lastActual 排最前，导致「只要漂到过 want+1，之后每次启动都直接绑它、
 * 再也不回头试 want」——want 从头到尾没被尝试过，面板却永久写着「配置 17321，被占了」。
 */
test('租约: 上次漂到 want+1 也不能把它顶到 want 前面', () => {
  const list = candidates(17321, 17322);
  assert.equal(list[0], 17321, '漂过一次不等于永久搬走');
  assert.equal(list[1], 17322);
  // 反复「启动」多次，第一位永远是配置值，不会一路往后爬
  let last = 17322;
  for (let i = 0; i < 5; i++) last = candidates(17321, last)[0];
  assert.equal(last, 17321, '连续多次启动也必须先试配置端口');
});

test('租约: 没有上次记录就从 want 开始', () => {
  const list = candidates(17321, null, 2);
  assert.deepEqual(list, [17321, 17322, 17323]);
});

test('租约: 写进去能读出来（want 和 actual 分开存）', () => {
  const dir = tmp();
  const lease = createLease({ file: join(dir, 'ports.json') });
  // pid 用自己的：actualOf 会校验「写这条租约的进程还活着没」，假 pid 会被当成僵死租约
  lease.claim('dsh', { want: 17321, actual: 17322, pid: process.pid });

  assert.equal(lease.actualOf('dsh'), 17322);
  assert.equal(lease.wantOf('dsh'), 17321);
  assert.equal(lease.actualOf('roost'), null, '没写过的槽位是 null');
});

/**
 * 僵死租约不能当路标。
 *
 * 真实事故：Roost 曾因端口被占漂到 `want+1`，租约里 actual 停在那儿；之后它干净地
 * 回到 want，而 dsh-roost 仍拿旧 actual 去探 → 探空 → 判定「没在跑」→ 再拉一个进程
 * → 第二个进程 claim 同一个 AppID 失败，用户看到「只配了一个机器人却说已有实例在运行」。
 *
 * pid 用一个几乎不可能存在的值（4 亿以后的 pid 在 Windows 上不会分配）。
 */
test('租约: 写入者已经死了，actual 不算数（否则会重复拉起）', () => {
  const dir = tmp();
  const lease = createLease({ file: join(dir, 'ports.json') });
  lease.claim('roost', { want: 15207, actual: 15208, pid: 400000001 });

  assert.equal(lease.actualOf('roost'), null, '僵死租约必须返回 null');
  assert.equal(lease.wantOf('roost'), 15207, 'want 是用户写的，不受 pid 影响');
});

test('租约: 没有 pid 字段的老文件仍然可读（拿不到证据时不否决）', () => {
  const dir = tmp();
  const file = join(dir, 'ports.json');
  writeFileSync(file, JSON.stringify({ roost: { want: 15207, actual: 15208 } }), 'utf8');

  const lease = createLease({ file });
  assert.equal(lease.actualOf('roost'), 15208, '老格式没有 pid，不能因此判成僵死');
});

test('租约: 两个槽位互不覆盖', () => {
  const dir = tmp();
  const lease = createLease({ file: join(dir, 'ports.json') });
  lease.claim('dsh', { want: 17321, actual: 17322 });
  lease.claim('roost', { want: 15210, actual: 15211 });

  assert.equal(lease.actualOf('dsh'), 17322);
  assert.equal(lease.actualOf('roost'), 15211);
});

test('租约: 文件坏了当作没有，不能因此起不来', () => {
  const dir = tmp();
  const file = join(dir, 'ports.json');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const lease = createLease({ file });
  assert.equal(lease.actualOf('dsh'), null);
  // 坏了也要能重新写
  lease.claim('dsh', { want: 17321, actual: 17322 });
  assert.equal(lease.actualOf('dsh'), 17322);
});

test('租约: 文件不存在也不炸', () => {
  const lease = createLease({ file: join(tmp(), 'nope', 'ports.json') });
  assert.equal(lease.actualOf('roost'), null);
});

/* ---------------- 收消息服务 ---------------- */

test('服务: 包装对象的 listening 在真 server 上，不在自己身上', async () => {
  /**
   * 这个坑踩过：/status 写成 `Boolean(server?.listening)`，
   * 但 `server` 是 createInboundServer 返回的包装对象，
   * 真正的 net.Server 在 `server.server` 里 —— 于是永远是 undefined，
   * 日志说「监听成功」、红条却说「端口没起来」，自相矛盾。
   */
  const port = 41000 + Math.floor(Math.random() * 2000);
  const srv = createInboundServer({ port, onInbound: () => {}, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(srv.listening, undefined, '包装对象自己没有 listening');
    assert.equal(srv.server.listening, true, '真 server 在 listening');
    assert.equal(srv.actualPort(), port, 'actualPort() 要返回数字，不是函数');
    assert.equal(typeof srv.actualPort(), 'number');
  } finally {
    srv.close();
  }
});

test('服务: 端口被占时自动顺延到下一个', async () => {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const first = createInboundServer({ port, onInbound: () => {}, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(first.actualPort(), port);

    // 同一个端口再起一个，应该落到 port+1
    const second = createInboundServer({
      port,
      ports: [port, port + 1, port + 2],
      onInbound: () => {},
      log: () => {},
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(second.actualPort(), port + 1, '被占就换下一个');
      assert.equal(second.server.listening, true);
    } finally {
      second.close();
    }
  } finally {
    first.close();
  }
});

/* ---------------- 激活 / 清理 ---------------- */

test('激活: 清理函数要把每条路由都注销掉', async () => {
  /**
   * 这个坑踩过：清理时只清了 mountOffs，把 `offs`（route 的返回值 =
   * register 的取消订阅函数）当成了「路由表」跳过。
   * 结果重载后同一路径注册两次，DSH 直接拒绝激活：
   *   `webserver: duplicate exact route "/roost/api/status"`
   *
   * 注意：apply() 用 ctx.effect 管生命周期，**不返回值**——
   * 清理函数得从 effect 里接。而且它会真的 bind 端口，必须 finally 关掉，
   * 否则测试进程不退出。
   */
  /**
   * 必须把数据目录指到临时目录：`apply()` 启动时会跑名字迁移，
   * 而它**会改人格文件**。不隔离的话，跑一次测试就把用户真实的
   * `~/.dsh/dsh-roost/personas/*.md` 改了（2026-11-01 真踩过）。
   */
  const oldEnv = process.env.DSH_ROOST_DATA;
  const testData = join(tmp(), 'data');
  process.env.DSH_ROOST_DATA = testData;

  const host = await import('../src/host.js');

  let registered = 0;
  let unsubscribed = 0;
  const cleanups = [];
  const noop = () => () => {};

  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: {
      register: () => {
        registered += 1;
        return () => {
          unsubscribed += 1;
        };
      },
    },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = cb();
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: testData,
    dir: testData,
  };

  try {
    host.apply(ctx);
    assert.ok(registered > 0, '应该注册了路由');
  } finally {
    for (const c of cleanups) {
      try {
        c();
      } catch {}
    }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }

  assert.equal(unsubscribed, registered, `注销数要等于注册数（${unsubscribed}/${registered}）`);
});

test('面板 quick：memory.mute 真的把会话写进 offChats', async () => {
  /**
   * 这条锁的是**只在运行时才炸**的那类错：quick 的处理器里调了 `setCfg(...)`，
   * 而 `setCfg` 只是传给 `createSetup()` 的一个属性，**不在 apply 的闭包里**。
   * `node --check` 查不出来，`dry-run.mjs` 也查不出来（它只跑 apply，不跑处理器），
   * 只有真的点一下按钮才炸 —— 而且被外层 try/catch 吞成一句 toast
   * 「setCfg is not defined」，用户看到的是"操作失败"，不是代码错。
   *
   * 所以这里把 /quick 的 handler 真的调一遍，连"写没写进盘上的配置"一起验。
   */
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');

  const routes = new Map();
  const cleanups = [];
  const noop = () => () => {};
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: {
      register: (r) => {
        routes.set(r.path, r.handler);
        return noop;
      },
    },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = cb();
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: join(dir, 'data'),
    dir,
  };

  /** 按面板的方式调一次 /quick：JSON body + 回环 Host */
  const call = async (body) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify(body);
      },
    };
    await routes.get('/roost/api/quick')(req, res);
    return res;
  };

  const offChatsOnDisk = () =>
    JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8')).memory.offChats;

  try {
    host.apply(ctx);
    assert.ok(routes.has('/roost/api/quick'), '没注册 /quick');

    const on = await call({ op: 'memory.mute', chatId: 'g1', actor: { bucket: 'owner' } });
    assert.equal(on.statusCode, 200, `状态 ${on.statusCode}：${JSON.stringify(on.body)}`);
    assert.equal(on.body.ok, true);
    assert.equal(on.body.muted, true);
    assert.deepEqual(offChatsOnDisk(), ['g1'], '没写进盘上的配置');

    const back = await call({ op: 'memory.unmute', chatId: 'g1', actor: { bucket: 'owner' } });
    assert.equal(back.body.muted, false);
    assert.deepEqual(offChatsOnDisk(), [], '取消后要清干净');
  } finally {
    for (const c of cleanups) {
      try {
        c();
      } catch {}
    }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }
});

/* ---------------- 配置 ---------------- */

test('配置：密钥打码，但能看出有没有设', () => {
  const a = publicConfig({ ...SPEAK_DEFAULTS, server: { port: 1, token: 'secret' } });
  assert.equal(a.server.token, '******', '设了 → 打码');

  const b = publicConfig({ ...SPEAK_DEFAULTS, server: { port: 1, token: '' } });
  assert.equal(b.server.token, '', '没设 → 空串，光看这个就够判断了');

  /**
   * 不许往配置里塞展示字段。
   *
   * 曾经加过 `tokenSet`：面板把整份 JSON 原样提交回来时，它就被写进了用户的
   * config.json，而且靠面板删不掉（`merge` 会从旧值补回来）。
   */
  assert.equal('tokenSet' in a, false, 'publicConfig 不能额外加字段');
  assert.equal('tokenSet' in b, false);

  /**
   * 磁盘上已经有的脏字段也不许露到面板。
   *
   * `cfg` 来自 `loadConfig()`，会把磁盘上的键全部带出来——不裁的话 `tokenSet`
   * 会出现在「配置全文」里，用户再点一次保存就又写回去了。
   */
  const dirty = publicConfig({ ...DEFAULTS, tokenSet: true, 乱写的: 1 });
  assert.equal('tokenSet' in dirty, false, '磁盘上的 tokenSet 不许露到面板');
  assert.equal('乱写的' in dirty, false, '磁盘上的未知键也不许露出来');
});

/**
 * 「配置全文」承诺的是「直接编辑 JSON」，那删掉一个字段就该真的没了。
 *
 * 以前的基线是磁盘上的旧配置，`merge` 只遍历用户提交的 key —— 删掉的字段
 * 会从旧配置原样补回来，删除静默失效。
 */
test('配置：删掉的字段回落到默认值，不从旧配置里补回来', () => {
  const dir = tmp();
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  try {
    saveConfig({ memory: { deepEvery: 99 }, server: { port: 17322 } });
    // 用户在面板上删掉 deepEvery 和整个 server 段
    const after = saveConfig({ memory: { enabled: true } });
    assert.equal(after.memory.deepEvery, DEFAULTS.memory.deepEvery, '删掉 → 回默认');
    assert.notEqual(after.memory.deepEvery, 99, '不能留着上次存的值');
    assert.equal(after.server.port, DEFAULTS.server.port, '删掉整段 → 整段回默认');

    // 落盘内容也要是回落后的，不能只在返回值里对
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.memory.deepEvery, DEFAULTS.memory.deepEvery);
    assert.equal(onDisk.server.port, DEFAULTS.server.port);
  } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = old;
  }
});

test('配置：DEFAULTS 之外的字段不落盘', () => {
  const dir = tmp();
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  try {
    const after = saveConfig({ server: { port: 17321 }, tokenSet: true, 乱写的: 1 });
    assert.equal('tokenSet' in after, false, '展示字段不许进配置文件');
    assert.equal('乱写的' in after, false, 'DEFAULTS 之外的键一律丢掉');
  } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = old;
  }
});

/**
 * 裁剪不能误伤动态字典。
 *
 * `persona.byChat` 在 DEFAULTS 里是 `{}`，键是群 openid、形状不可知——
 * 按形状裁剪会把用户的按群配置全部清空。空对象必须整份保留。
 */
test('配置：按群指定人格（persona.byChat）不会被裁剪掉', () => {
  const dir = tmp();
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  try {
    const after = saveConfig({ persona: { byChat: { 群A: '毒舌群友', 群B: '小栖' } } });
    assert.deepEqual(after.persona.byChat, { 群A: '毒舌群友', 群B: '小栖' }, '动态字典要原样保留');
  } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = old;
  }
});

test('配置：默认端口跟 ai-chat 的默认地址对上', () => {
  assert.equal(DEFAULTS.server.port, 17321);
});

test('面板 quick：能力页的启用 / 改 / 读，以及"没启用时不许改"', async () => {
  /**
   * 锁三件事：
   *  1. 没有 `capabilities.json` 时 `enabled=false`——老用户装上新版本行为不变。
   *  2. 未启用直接 patch 要 409，不能悄悄建一份文件出来。
   *  3. 启用时**以旧的 `permissions` 为种子**：老用户把某档调成 `all`，
   *     不能一启用就被打回白名单（那是悄悄降权）。
   */
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');

  const routes = new Map();
  const cleanups = [];
  const noop = () => () => {};
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { const off = cb(); if (typeof off === 'function') cleanups.push(off); return noop; },
    on: () => noop,
    dataDir: join(dir, 'data'),
    dir,
  };

  const call = async (body) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); },
    };
    await routes.get('/roost/api/quick')(req, res);
    return res;
  };

  const capFile = () => join(process.env.DSH_ROOST_DATA, 'capabilities.json');

  try {
    host.apply(ctx);

    const before = await call({ op: 'capabilities.get' });
    assert.equal(before.body.ok, true);
    assert.equal(before.body.enabled, false, '没有文件时必须是未启用');
    assert.equal(existsSync(capFile()), false, '读一次不该建文件');

    const tooEarly = await call({ op: 'capabilities.patch', arg: { newTools: 'nobody' } });
    assert.equal(tooEarly.statusCode, 409, '未启用就改必须拒绝');
    assert.equal(existsSync(capFile()), false);

    const bad = await call({ op: 'capabilities.patch', arg: 'nope' });
    assert.ok(bad.statusCode === 400 || bad.statusCode === 409);

    const on = await call({ op: 'capabilities.init' });
    assert.equal(on.statusCode, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
    assert.ok(existsSync(capFile()), '启用后要真的写盘');
    assert.deepEqual(on.body.store.defaults.owner.allow, ['*'], '主人档默认全给');
    /**
     * `permissions: 'chat'` 的档位迁移成**旧的 `GUEST_KEEP_TOOLS`**，
     * 不是 `defaultStore()` 那套默认值。差在 `memory_note` / `sticker_pick`：
     * 旧 chat 模式会把它们收走，用默认值当种子等于顺手给了权限——
     * 而用户看到的是「我什么都没改，他们怎么多了两个能力」。
     */
    assert.deepEqual(
      on.body.store.defaults.member.allow,
      ['memory_search', 'qq_send', 'qq_close'],
      'chat 档迁移必须和旧行为逐字等价',
    );

    const after = await call({ op: 'capabilities.get' });
    assert.equal(after.body.enabled, true);
    assert.ok(after.body.store.seen, '要带 seen 快照字段');

    /**
     * 试算必须覆盖**全部六档**。
     *
     * 之前这里默认只有四个（缺 manager / helper），而页面标题写「五个档位」——
     * 前端 `if (!r) return null` 把缺数据的卡整块跳过，群管和助手两张卡
     * 根本没渲染出来，工具弹窗里那两列也全是空勾。
     */
    const pv = await call({ op: 'capabilities.preview', arg: {} });
    assert.equal(pv.statusCode, 200);
    assert.deepEqual(
      pv.body.results.map((r) => r.bucket),
      ['owner', 'admin', 'manager', 'helper', 'member', 'unknown'],
      '试算要五档 + 兜底档，不能少',
    );

    const patched = await call({ op: 'capabilities.patch', arg: { newTools: 'nobody' } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.store.newTools, 'nobody');

    const disk = JSON.parse(readFileSync(capFile(), 'utf8'));
    assert.equal(disk.newTools, 'nobody', '改动要落盘');

    const acked = await call({ op: 'capabilities.ack' });
    assert.equal(acked.body.ok, true);
  } finally {
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }
});

test('面板 quick：功能开关的读写，以及「关掉功能要真的收工具」', async () => {
  /**
   * 锁四件事：
   *  1. `features.get` 把 11 个开关和分组都给出来，且状态来自 config；
   *  2. 关掉「分段说话」写的是 **config.json**（和设置页同一份），不是另存一份；
   *  3. `awake` 依赖 `speakUp`，后者关着时打开前者要 409 并说清先开哪个；
   *  4. 发文件没有 config 字段，未启用能力策略时改它会 409，而不是悄悄丢掉。
   */
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');

  const routes = new Map();
  const cleanups = [];
  const noop = () => () => {};
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: {
      register: (r) => {
        routes.set(r.path, r.handler);
        return noop;
      },
    },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = cb();
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: join(dir, 'data'),
    dir,
  };

  const call = async (body) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); },
    };
    await routes.get('/roost/api/quick')(req, res);
    return res;
  };

  try {
    host.apply(ctx);

    const all = await call({ op: 'features.get' });
    assert.equal(all.body.ok, true);
    /**
     * 别写死数字：阶段 4a 起骨架开关逐个上线（moodEffects 是第一个），
     * 每上一个都要改一次老用例太脆，而且失败信息看不出是谁多了。
     * 直接拿 features.js 的可见集合对，顺便锁住「面板下发的 = 已上线的」。
     */
    const { visibleFeatures, visibleGroups } = await import('../src/features.js');
    const visible = visibleFeatures();
    assert.equal(all.body.features.length, visible.length, `开关数量变了：${all.body.features.length}`);
    assert.equal(all.body.groups.length, visibleGroups(visible).length);
    assert.equal(all.body.raw.chatLookForMembers, false, '新开关默认关（DEFAULTS 里显式写了 false）');
    assert.equal(all.body.on.chatLookForMembers, false, '面板上也是关');

    // 默认：主动搭话关着（DEFAULTS 里就是 false），其余开
    assert.equal(all.body.raw.speakUp, false, 'speakUp 默认关');
    assert.equal(all.body.raw.awake, true, 'awake 配置是 true');
    assert.equal(all.body.on.awake, false, 'awake 依赖 speakUp，应显示为关');
    assert.ok(all.body.blocked.awake.includes('主动搭话'), `blocked 要说清原因：${all.body.blocked.awake}`);

    // 依赖没满足时打开 → 409，且不写盘
    const bad = await call({ op: 'features.patch', arg: { id: 'awake', on: true } });
    assert.equal(bad.statusCode, 409);
    assert.ok(bad.body.message.includes('主动搭话'));

    // 关「分段说话」：写进 config.json
    const off = await call({ op: 'features.patch', arg: { id: 'qqTools', on: false } });
    assert.equal(off.statusCode, 200, JSON.stringify(off.body));
    const disk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
    assert.equal(disk.qqTools.enabled, false, '要落到 config.json，不能另存一份');

    const after = await call({ op: 'features.get' });
    assert.equal(after.body.raw.qqTools, false);
    // seen 是空的（没观察过工具），所以 wouldRemove 也就是空的——这里只验证不炸
    assert.ok(Array.isArray(after.body.wouldRemove));

    // 未知开关 → 400
    const nope = await call({ op: 'features.patch', arg: { id: '没有这个', on: false } });
    assert.equal(nope.statusCode, 400);

    /**
     * 数值项：空值必须 400。走完整 quick 路径，不只是纯函数——
     * `Number('') === 0` 会把 `queueMax` 静默写成 0（关掉排队）并回「已保存」，
     * 这是审校抓到的真实 P0，前后端各挡一层、测试锁死。
     */
    for (const v of ['', '  ', null]) {
      const empty = await call({ op: 'features.patch', arg: { id: 'queueMax', value: v } });
      assert.equal(empty.statusCode, 400, `空值 ${JSON.stringify(v)} 不能写进配置`);
    }
    const zero = await call({ op: 'features.patch', arg: { id: 'queueMax', value: 0 } });
    assert.equal(zero.statusCode, 200, '0 是合法的「关掉排队」');
    assert.equal(zero.body.value, 0);
    const four = await call({ op: 'features.patch', arg: { id: 'queueMax', value: 4 } });
    assert.equal(four.statusCode, 200);
    assert.equal(four.body.value, 4);

    // 发文件存在能力策略里：没启用时改它要 409，而不是假装成功
    const noStore = await call({ op: 'features.patch', arg: { id: 'sendFile', on: false } });
    assert.equal(noStore.statusCode, 409, JSON.stringify(noStore.body));

    // 启用能力策略之后就能改了
    await call({ op: 'capabilities.init' });
    const okStore = await call({ op: 'features.patch', arg: { id: 'sendFile', on: false } });
    assert.equal(okStore.statusCode, 200, JSON.stringify(okStore.body));
    const capDisk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'capabilities.json'), 'utf8'));
    assert.equal(capDisk.features.sendFile, false);
  } finally {
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }
});

test('面板 quick：配额的读 / 改 / 清零，以及非法值要拒', async () => {
  /**
   * 配额写的是「用户手填的数字」，所以校验比功能开关重要：
   * 一个 `"abc"` 混进去，`charge()` 里 `Number()` 得 NaN，
   * `used >= NaN` 永远 false —— 额度静默变成不限，没人会发现。
   */
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');

  const routes = new Map();
  const cleanups = [];
  const noop = () => () => {};
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { const off = cb(); if (typeof off === 'function') cleanups.push(off); return noop; },
    on: () => noop,
    dataDir: join(dir, 'data'),
    dir,
  };

  const call = async (body) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = { headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
    await routes.get('/roost/api/quick')(req, res);
    return res;
  };

  try {
    host.apply(ctx);

    const all = await call({ op: 'quota.get' });
    assert.equal(all.body.ok, true);
    assert.equal(all.body.rows.length, 5, `配额项数量变了：${all.body.rows.length}`);
    const voice = all.body.rows.find((r) => r.feature === 'voice');
    /** 默认不限（`-1`）：装上新版本不能突然开始拦人，见 quota.js 文件头 */
    assert.equal(voice.max, -1);
    assert.equal(voice.suggest, 3, '建议值还是要给出来，否则输入框只能瞎猜');
    assert.equal(voice.per, 'person');
    assert.equal(voice.window, 'day');

    // 非法输入
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', max: 'abc' } })).statusCode, 400);
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', max: -5 } })).statusCode, 400);
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', window: '每周' } })).statusCode, 400);
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', per: '每人' } })).statusCode, 400);
    // 名字不合法要拒（带空格 / 引号会把 quota.json 的键写坏）
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'web search', max: 1 } })).statusCode, 400);
    assert.equal((await call({ op: 'quota.patch', arg: { feature: '', max: 1 } })).statusCode, 400);
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice' } })).statusCode, 400, '什么都没说要拒');

    /**
     * **任意工具名都能配**——这是「只给联网搜索限次数」的入口。
     * 名字暂时不在池子里也放行：插件装了卸了、DSH 升级改名，
     * 配额是持久配置，不该因为「此刻没有这个工具」就写不进去。
     */
    const tool = await call({ op: 'quota.patch', arg: { feature: 'web_search', max: 20 } });
    assert.equal(tool.statusCode, 200, JSON.stringify(tool.body));
    assert.equal(JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8')).quota.web_search.max, 20);

    const withTool = await call({ op: 'quota.get' });
    const row = withTool.body.rows.find((r) => r.feature === 'web_search');
    assert.ok(row, '自定义工具配额要出现在 rows 里');
    assert.equal(row.max, 20);
    assert.equal(row.per, 'person', '没写单位时默认每人');
    assert.equal(row.window, 'day', '没写窗口时默认每天');
    assert.ok(Array.isArray(withTool.body.pool), 'quota.get 要带工具池');
    assert.ok(Array.isArray(withTool.body.builtin), 'quota.get 要带内置项名单');

    // -1 是「不限」的约定写法（面板清空输入框就是它），必须放行
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', max: -1 } })).statusCode, 200);

    /**
     * 按档位设额度：只改这一档，别动默认值。
     *
     * 混在一起的话，用户改完群成员，主人也跟着变——
     * 那这个功能就等于没做。
     */
    const byB = await call({ op: 'quota.patch', arg: { feature: 'voice', max: 0, bucket: 'member' } });
    assert.equal(byB.statusCode, 200, JSON.stringify(byB.body));
    const bDisk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
    assert.equal(bDisk.quota.voice.byBucket.member, 0);
    assert.equal(bDisk.quota.voice.max, -1, '顶层默认值不该被动过');

    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', bucket: 'member' } })).statusCode, 400, '只给档位不给次数要拒');
    assert.equal((await call({ op: 'quota.patch', arg: { feature: 'voice', max: 1, bucket: '老板' } })).statusCode, 400);

    /**
     * **五档都要能改**。
     *
     * 这条是回归测试：档位名单曾经在这里写死成四个（缺 manager / helper），
     * 而前端下拉是五档——用户选「群管」改额度，直接吃一个 400，
     * 界面上看是「点了没反应」。名单必须跟 `BUCKETS` 走，不能另抄一份。
     */
    for (const b of ['owner', 'admin', 'manager', 'helper', 'member', 'unknown']) {
      const one = await call({ op: 'quota.patch', arg: { feature: 'voice', max: 3, bucket: b } });
      assert.equal(one.statusCode, 200, `${b} 档应当能改额度：${JSON.stringify(one.body)}`);
    }

    // 正常改 → 落到 config.json，且立刻反映在 quota.get 里
    const up = await call({ op: 'quota.patch', arg: { feature: 'voice', max: 7 } });
    assert.equal(up.statusCode, 200, JSON.stringify(up.body));
    const disk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
    assert.equal(disk.quota.voice.max, 7);

    const after = await call({ op: 'quota.get' });
    assert.equal(after.body.rows.find((r) => r.feature === 'voice').max, 7, '改完要立刻生效');

    // 清零不报错（计数文件可能还不存在）
    assert.equal((await call({ op: 'quota.reset', arg: { feature: 'voice' } })).statusCode, 200);
    assert.equal((await call({ op: 'quota.reset', arg: {} })).statusCode, 200);
    assert.equal((await call({ op: 'quota.reset', arg: { feature: '不存在' } })).statusCode, 400);
  } finally {
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }
});
