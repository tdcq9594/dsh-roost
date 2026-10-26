// dsh-roost 的测试
//
// 只测「不依赖 DSH 也能测」的部分：整形、会话映射、HTTP 契约、一轮的状态机。
// 真正的联调（DSH 会话、agent）得在真环境里跑，这里用假 agent 顶。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderInbound, chatOf } from '../src/inbound.js';
import { createSessions } from '../src/sessions.js';
import { createInboundServer, postReply } from '../src/server.js';
import { createTurnRunner, textOf } from '../src/turn.js';
import { DEFAULTS, publicConfig } from '../src/config.js';
import { bucketOf, modeFor, describeSpeaker, rulesFor } from '../src/permissions.js';
import { createSetup } from '../src/setup.js';
import { createPersonas } from '../src/personas.js';
import { createStickers, tagsOf } from '../src/stickers.js';
import { createLease, candidates } from '../src/lease.js';
import { shouldFire, inAwakeWindow, scheduleNext, DEFAULTS as SPEAK_DEFAULTS } from '../src/speakup.js';

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
  p.save('../../evil', 'x');
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
  assert.match(p, /<<image:/);
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

/* ---------------- 端口租约 ---------------- */

test('租约: 候选端口从 want 往后排，上次的 actual 优先', () => {
  const list = candidates(17321, 17323, 3);
  assert.equal(list[0], 17323, '上次实际用的排最前');
  assert.equal(list[1], 17321);
  assert.deepEqual(list.slice(2), [17322, 17323, 17324].filter((p) => p !== 17323));
  assert.equal(new Set(list).size, list.length, '不能有重复');
});

test('租约: 没有上次记录就从 want 开始', () => {
  const list = candidates(17321, null, 2);
  assert.deepEqual(list, [17321, 17322, 17323]);
});

test('租约: 写进去能读出来（want 和 actual 分开存）', () => {
  const dir = tmp();
  const lease = createLease({ file: join(dir, 'ports.json') });
  lease.claim('dsh', { want: 17321, actual: 17322, pid: 123 });

  assert.equal(lease.actualOf('dsh'), 17322);
  assert.equal(lease.wantOf('dsh'), 17321);
  assert.equal(lease.actualOf('roost'), null, '没写过的槽位是 null');
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
    dataDir: join(tmp(), 'data'),
    dir: tmp(),
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
  }

  assert.equal(unsubscribed, registered, `注销数要等于注册数（${unsubscribed}/${registered}）`);
});

/* ---------------- 配置 ---------------- */

test('配置：密钥打码，但能看出有没有设', () => {
  const a = publicConfig({ ...SPEAK_DEFAULTS, server: { port: 1, token: 'secret' } });
  assert.equal(a.server.token, '******');
  assert.equal(a.tokenSet, true);

  const b = publicConfig({ ...SPEAK_DEFAULTS, server: { port: 1, token: '' } });
  assert.equal(b.tokenSet, false);
});

test('配置：默认端口跟 ai-chat 的默认地址对上', () => {
  assert.equal(DEFAULTS.server.port, 17321);
});
