// 宿主路由级测试：真的把 apply() 跑起来、真的打 /roost/api/*。
//
// 为什么需要这一层：前面那些测试都是纯函数，测不到"接没接上"。
// 上一轮 `journal.clearChat` 就是功能写好了、没人调——纯函数测试全绿，
// 但那条路根本没通。这里专治这一类。
//
// 关键技巧：`ctx.effect` 有 label，第一条是"收消息服务"（会真 bind 端口）。
// 假 ctx 跳过它、只跑第二条（面板接口），于是路由注册了、端口没起。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

/**
 * 造一个假 ctx 并把 host 跑起来。
 * @param {object} cfgPatch 写进 config.json 的覆盖项
 */
async function bootHost(cfgPatch = {}, seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-routes-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfgPatch), 'utf8');
  // 塞几条真实事实，才能区分"关掉了"和"本来就是空的"
  if (seed.memory) {
    writeFileSync(join(dir, 'memory.json'), JSON.stringify(seed.memory), 'utf8');
  }
  // 种子会话映射：面板的会话下拉读它
  if (seed.sessions) {
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ chats: seed.sessions }), 'utf8');
  }
  // 种子日记：用同一个模块写库，路径和 host 里的一致
  if (seed.journal?.length) {
    const { createJournal } = await import('../src/journal.js');
    const j = createJournal({ file: join(dir, 'journal.sqlite') });
    for (const row of seed.journal) j.add(row);
    j.close();
  }
  // host 里的 dataDir() 读这个环境变量，必须在 import 之前设
  process.env.DSH_ROOST_DATA = dir;

  const routes = new Map();
  const logs = [];
  const fakeCtx = {
    agents: {
      get: () => null,
      create: async () => ({ id: 'a1', ctx: { systemPrompt: { context: noop }, tools: {} } }),
      list: () => [],
    },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's1' }) },
    systemPrompt: { context: () => noop },
    webServer: {
      register: (r) => {
        routes.set(r.path, r.handler);
        return noop;
      },
    },
    config: {},
    logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    effect: (cb, label) => {
      // 跳过会 bind 端口的那条，否则测试进程吊着不放
      if (String(label).includes('收消息服务')) return noop;
      const off = cb();
      return typeof off === 'function' ? off : noop;
    },
    on: () => noop,
  };

  // 每次 boot 都重新 import，让 config 缓存跟着新的 DSH_ROOST_DATA 走
  const url = new URL('../src/host.js', import.meta.url);
  url.searchParams.set('t', String(Date.now()) + Math.random());
  const host = await import(url.href);
  const off = host.apply(fakeCtx);

  const call = async (path, { method = 'GET', body = null, headers = {} } = {}) => {
    const handler = routes.get('/roost/api' + path.split('?')[0]);
    if (!handler) throw new Error(`路由没注册：${path}`);
    let out = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(s) {
        out = s;
      },
    };
    const req = {
      url: path,
      method,
      /**
       * 真实面板请求就是这样：回环 Host + 同源标记。
       * 路由层现在统一过栅栏（`fence.js`），少了这两个头会被 403——
       * 那不是测试噪音，正是要断言的行为（见文件末尾那两条）。
       */
      headers: { host: '127.0.0.1:17321', 'sec-fetch-site': 'same-origin', ...headers },
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(JSON.stringify(body));
      },
    };
    await handler(req, res);
    return { status: res.statusCode, json: out ? JSON.parse(out) : null };
  };

  return { dir, routes, call, off, logs };
}

test('路由：apply 之后面板接口都在', async () => {
  const { routes, off } = await bootHost();
  for (const p of ['/roost/api/memory', '/roost/api/mind', '/roost/api/journal', '/roost/api/graph',
    '/roost/api/awake', '/roost/api/compact', '/roost/api/channels', '/roost/api/registrations']) {
    assert.ok(routes.has(p), `缺路由 ${p}`);
  }
  off?.();
});

const SEED = { memory: { global: ['主人住在杭州'], chats: { g1: ['这群管张三叫鱼头'] }, personas: {} } };

test('路由：memory.enabled=false 时 /mind 的记忆块是空的', async () => {
  const { call, off } = await bootHost({ memory: { enabled: false } }, SEED);
  const r = await call('/mind');
  assert.equal(r.status, 200);
  assert.equal(r.json.memoryText, '', '关掉记忆就必须一个字都不注入');
  off?.();
});

test('路由：memory.enabled 开着时同一份数据会注入（对照组）', async () => {
  const { call, off } = await bootHost({}, SEED);
  const r = await call('/mind');
  assert.equal(r.status, 200);
  assert.ok(r.json.memoryText.length > 0, '开着就必须注入，否则这个开关测不出东西');
  assert.match(r.json.memoryText, /主人住在杭州/);
  off?.();
});

test('路由：/channels 的能力表说清楚哪些平台没有', async () => {
  const { call, off } = await bootHost();
  const r = await call('/channels');
  assert.equal(r.json.ok, true);
  const caps = r.json.capabilities.qq;
  assert.equal(caps.poke, false);
  assert.equal(caps.stream, 'c2c');
  off?.();
});

test('路由：/compact 给出的阈值跟场景走', async () => {
  const { call, off } = await bootHost();
  const r = await call('/compact');
  assert.equal(r.status, 200);
  // 没有会话时占用读不到，但阈值字段要能看见
  assert.equal(typeof r.json.cfg.atPercentGroup, 'number');
  assert.equal(typeof r.json.cfg.atPercentC2C, 'number');
  off?.();
});

test('路由：/registrations 列出两种接入方式', async () => {
  const { call, off } = await bootHost();
  const r = await call('/registrations');
  assert.deepEqual(r.json.list.map((x) => x.name), ['qr', 'manual']);
  off?.();
});

/* ---------------- 第 3 批：注入拆两段 ---------------- */

const NOW = Date.now();
const JOURNAL_SEED = [
  { id: 'j1', at: NOW - 3000, chatId: 'g1', sender: '张三', text: '我住在杭州，喜欢喝龙井' },
  { id: 'j2', at: NOW - 2000, chatId: 'g1', role: 'bot', text: '那下次给你带点龙井' },
];

test('注入分段：易变内容（刚才说到/条数）不在 system 段里', async () => {
  const { call, off } = await bootHost({}, { journal: JOURNAL_SEED });
  const r = await call('/mind?deep=1');
  assert.equal(r.status, 200);
  const stat = r.json.memoryStaticText;
  const dyn = r.json.memoryDynamicText;

  // 稳定段：可以进 system prompt 的
  assert.match(stat, /只在这个群发生过的事别拿到别处说/, '串场规则必须在稳定段');
  // 易变段：每轮变的，必须挪出去
  assert.match(dyn, /刚才说到/, '最近说的属于易变段');
  assert.doesNotMatch(stat, /刚才说到/, '稳定段里不能有每轮都变的内容，否则缓存轮轮失效');
  assert.doesNotMatch(stat, /还有一本日记/, '日记条数每轮会变，属于易变段');
  off?.();
});

test('注入分段：两段合起来等于 memoryText（没有内容丢失）', async () => {
  const { call, off } = await bootHost({}, { journal: JOURNAL_SEED });
  const r = await call('/mind?deep=1');
  const { memoryStaticText: s, memoryDynamicText: d, memoryText: t } = r.json;
  assert.equal(t, [s, d].filter(Boolean).join('\n\n'));
  assert.ok(s.length > 0 && d.length > 0);
  off?.();
});

test('注入分段：关掉记忆时两段都为空', async () => {
  const { call, off } = await bootHost({ memory: { enabled: false } }, { journal: JOURNAL_SEED });
  const r = await call('/mind');
  assert.equal(r.json.memoryStaticText, '');
  assert.equal(r.json.memoryDynamicText, '');
  off?.();
});

test('注入分段：freezeSystem=false 能退回旧行为（全部进 system）', async () => {
  const { call, off } = await bootHost({ memory: { freezeSystem: false } });
  const r = await call('/mind');
  assert.equal(r.json.budgets.memory.freezeSystem, false);
  off?.();
});

/* ---------------- 前后端对齐（结构性检查） ---------------- */

/**
 * 这条不是测行为，是**防漂移**。
 *
 * 上一轮出现过「后端加了记忆层、前端还在展示旧的两层」；
 * 这一轮出现过「后端有 /graph 的 ended 字段、前端没调，于是整块内容静默消失」。
 * 两种都不会报错，只能靠人发现。
 *
 * 所以在测试里直接读两个源码文件比对：后端注册的每条路由，
 * 前端那个文件里必须出现同名路径。
 */
test('对齐：后端每条路由在前端都有入口', async () => {
  const { readFileSync } = await import('node:fs');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  const routes = [...host.matchAll(/route\('(\/[a-z/-]+)'/g)].map((m) => m[1]);
  assert.ok(routes.length >= 30, `只解析到 ${routes.length} 条路由，正则可能失效了`);

  const missing = routes.filter((p) => !client.includes(`'${p}`));
  assert.deepEqual(missing, [], `这些后端路由前端没有入口：${missing.join('、')}`);
});

test('对齐：前端调用的每个路径后端都存在', async () => {
  const { readFileSync } = await import('node:fs');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  const routes = new Set([...host.matchAll(/route\('(\/[a-z/-]+)'/g)].map((m) => m[1]));
  const called = new Set([
    ...[...client.matchAll(/(?:get|post)\('(\/[a-z/-]+)/g)].map((m) => m[1]),
    ...[...client.matchAll(/run\('(\/[a-z/-]+)/g)].map((m) => m[1]),
  ]);
  const dead = [...called].filter((p) => !routes.has(p));
  assert.deepEqual(dead, [], `前端在调不存在的接口：${dead.join('、')}`);
});

test('对齐：设置页列出的配置段后端都有', async () => {
  const { readFileSync } = await import('node:fs');
  const { DEFAULTS } = await import('../src/config.js');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  const block = client.slice(client.indexOf('const JSON_SECTIONS'), client.indexOf('function ConfigTab'));
  const keys = [...block.matchAll(/\['([a-zA-Z]+)',/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `只解析到 ${keys.length} 个配置段`);

  const missing = keys.filter((k) => !(k in DEFAULTS));
  assert.deepEqual(missing, [], `设置页列了后端没有的配置段：${missing.join('、')}`);
});

/**
 * 反向也要查。
 *
 * 上一版只查「前端列的 ⊂ 后端有」，于是后端新加了 `closing` / `qqTools` / `update`
 * 三段，设置页一直没列，测试全绿——用户根本不知道有这几个配置项。
 */
test('对齐：后端有的配置段，设置页也要列出来', async () => {
  const { readFileSync } = await import('node:fs');
  const { DEFAULTS } = await import('../src/config.js');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  const block = client.slice(client.indexOf('const JSON_SECTIONS'), client.indexOf('function ConfigTab'));
  const keys = [...block.matchAll(/\['([a-zA-Z]+)',/g)].map((m) => m[1]);

  const missing = Object.keys(DEFAULTS).filter((k) => !keys.includes(k));
  assert.deepEqual(missing, [], `后端有、设置页没列出的配置段：${missing.join('、')}`);
});

/* ---------------- /config 保存的校验 ---------------- */

/**
 * 「提示存好了，磁盘一个字没改」是最坑的一类失败。
 * `JSON.parse('[]' | '"abc"' | '123')` 都能过 parse，但都不是配置对象。
 */
test('配置：根不是对象时 400，不能静默成功', async () => {
  const { call, off } = await bootHost();
  try {
    for (const bad of [[], 'abc', 123]) {
      const r = await call('/config', { method: 'PUT', body: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} 必须被拒`);
      assert.equal(r.json.ok, false);
      assert.match(r.json.message, /JSON 对象/, '要说清该传什么形状');
    }
  } finally {
    off?.();
  }
});

/**
 * 端口不校验的后果：`listen('abc')` 抛 EACCES，而顺延逻辑只认 EADDRINUSE，
 * 于是服务直接起不来，面板只有一句 `permission denied abc`。
 */
test('配置：端口非法时 400，并说清范围', async () => {
  const { call, off } = await bootHost();
  try {
    for (const bad of ['abc', 0, 99999, 1.5, null]) {
      const r = await call('/config', { method: 'PUT', body: { server: { port: bad } } });
      assert.equal(r.status, 400, `port=${JSON.stringify(bad)} 必须被拒`);
      assert.match(r.json.message, /1–65535/, '要给出合法范围');
    }
  } finally {
    off?.();
  }
});

/**
 * 打码的密钥原样提交回来，真值必须保住。
 *
 * `saveConfig` 的基线是 DEFAULTS（token 默认空串），所以「把 `******` 删掉」
 * 等于主动提交「没有 token」——真密钥会被空串顶掉。这里钉死这个行为：
 * 占位符要回填真值，而用户真的填 `''` 才表示清空。
 */
test('配置：打码的密钥原样提交回来，真密钥不能被冲成空', async () => {
  const { call, off } = await bootHost({ server: { port: 17321, token: 'REAL_SECRET' } });
  try {
    const got = await call('/config');
    assert.equal(got.json.config.server.token, '******', '面板只该看到打码值');

    // 用户什么都不改，直接点保存
    const r = await call('/config', { method: 'PUT', body: got.json.config });
    assert.equal(r.status, 200);
    assert.equal(r.json.config.server.token, '******', '真密钥不能被冲成空');
    assert.equal(r.json.message, '已保存', '端口和密钥都没变，不该重启服务');
  } finally {
    off?.();
  }
});

/* ---------------- 字段级对齐（比路由级更细一层） ---------------- */

/**
 * 为什么还要这一层。
 *
 * 上一版的对齐断言只比对**路由名**：`/logs` 后端有、前端也在调，测试全绿——
 * 但后端返回 `entries`、前端读 `r.logs`，于是日志页永远是「还没有日志」。
 * 同理「接入进度」读的是后端根本不返回的 `steps`，于是永远 0/4。
 *
 * 这两类错误**不报错、不崩**，只能靠显式钉住键名。
 */

test('字段：/logs 返回 entries，前端读的也是 entries', async () => {
  const { call, off } = await bootHost();
  const r = await call('/logs');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entries), '后端必须返回 entries');

  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes('r.entries'), '前端必须读 entries');
  assert.ok(!/r\.logs\s*\|\|/.test(client), '前端不能读不存在的 r.logs');
  off?.();
});

test('字段：/setup 的五个判据都在且是布尔（前端靠它们推进度）', async () => {
  // 指一个不存在的目录：detect 就不会去连真实 Roost，测试与机器状态无关
  const { call, off } = await bootHost({ setup: { roostDir: join(tmpdir(), 'no-such-roost-xyz') } });
  const r = await call('/setup');
  assert.equal(r.status, 200, '/setup 不能 500');
  for (const k of ['installed', 'hasBot', 'running', 'pluginInstalled', 'pluginConfigured']) {
    assert.equal(typeof r.json[k], 'boolean', `${k} 必须是布尔`);
  }
  assert.equal(r.json.installed, false);
  // 目录填错时要能说清为什么，而不是只说"没装"
  assert.match(String(r.json.dirHow), /不是一份 Roost/);

  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  for (const k of ['installed', 'hasBot', 'pluginInstalled', 'pluginConfigured', 'dirHow']) {
    assert.ok(client.includes(k), `前端应该用到 ${k}`);
  }
  // 只禁"读这个字段"，不禁注释里提到它（注释正是在记录这个坑）
  assert.ok(!/setupSt\??\.steps/.test(client), '前端不许再读后端不存在的 setupSt.steps');
  off?.();
});

test('记忆：/memory 能指定 chatId，并回 chats + scene', async () => {
  const { call, off } = await bootHost({}, SEED);
  const r = await call('/memory?chatId=g1');
  assert.equal(r.status, 200);
  assert.equal(r.json.chatId, 'g1', '指定了就必须用指定的，不能还跟着 lastScene 走');
  assert.deepEqual(r.json.chat, ['这群管张三叫鱼头'], '本群的记忆要按 chatId 取');
  assert.ok(Array.isArray(r.json.chats), '要给出可切换的会话清单');
  off?.();
});

test('记忆：没给 chatId 时退回最近会话（不传就还是旧行为）', async () => {
  const { call, off } = await bootHost({}, SEED);
  const r = await call('/memory');
  assert.equal(r.status, 200);
  assert.equal(r.json.chatId, '', '没聊过天时是空串，前端据此禁用「本群」写入');
  assert.equal(r.json.scene, null);
  off?.();
});

test('记忆：/graph 也认 chatId', async () => {
  const { call, off } = await bootHost({}, SEED);
  const r = await call('/graph?chatId=g1');
  assert.equal(r.status, 200);
  assert.equal(r.json.chatId, 'g1');
  off?.();
});

/**
 * 会话清单必须带「群 / 私聊」。
 *
 * QQ 官方事件里没有群名（只有 openid），ai-chat 取不到群名就回退成
 * 发消息那个人的昵称——于是群和私聊的 title 变成**同一个人名**，
 * 面板下拉两行长得一模一样，用户根本分不出哪个是群。
 * `kind` 就是为了补这个洞：没有它，前端没法标出类型。
 */
test('记忆：/memory 的会话清单带 kind（群 / 私聊能分开）', async () => {
  const { call, off } = await bootHost({}, {
    sessions: {
      g1: { sessionId: 's1', preset: 'roost-social', title: '倦飞之鸟', kind: 'group', at: 2 },
      u1: { sessionId: 's2', preset: 'roost-private', title: '倦飞之鸟', kind: 'c2c', at: 1 },
    },
  });
  const r = await call('/memory?chatId=g1');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries((r.json.chats || []).map((c) => [c.chatId, c]));
  assert.equal(byId.g1?.kind, 'group', '群会话的 kind 必须是 group');
  assert.equal(byId.u1?.kind, 'c2c', '私聊会话的 kind 必须是 c2c');
  // 两者 title 一样，但 kind 不同 —— 前端靠它加标签
  assert.equal(byId.g1?.title, byId.u1?.title, '这个测试的前提：两条 title 相同');
  off?.();
});

test('记忆：老会话没有 kind 时，从 preset 反推（存量数据也能标）', async () => {
  const { call, off } = await bootHost({}, {
    sessions: {
      g1: { sessionId: 's1', preset: 'roost-social', title: '某群', at: 2 },
      u1: { sessionId: 's2', preset: 'roost-private', title: '某人', at: 1 },
    },
  });
  const r = await call('/memory?chatId=g1');
  const byId = Object.fromEntries((r.json.chats || []).map((c) => [c.chatId, c]));
  assert.equal(byId.g1?.kind, 'group', 'roost-social 应反推成 group');
  assert.equal(byId.u1?.kind, 'c2c', 'roost-private 应反推成 c2c');
  off?.();
});

/**
 * `/setup/sync`：面板红字旁边那个「现在就改过来」的后端。
 *
 * 为什么单独测：这条路由**只改 dshUrl 一行**，和 `/setup/configure`
 * （会连 adapter / publicUrl / decide 一起重刷）不是一回事。混用会把用户
 * 手动调过的插件配置冲掉。这里盯住「路由在、能回话、不抛」。
 */
test('路由：/setup/sync 在，且没装 Roost 时也老实回话不抛', async () => {
  const { routes, call, off } = await bootHost();
  assert.ok(routes.has('/roost/api/setup/sync'), '缺路由 /setup/sync');
  const r = await call('/setup/sync', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, '同步不上不算请求失败，别让面板弹红');
  // 测试环境里没有真的 Roost 在跑，只可能落在这两种
  assert.ok(
    r.json.skipped === true || r.json.message,
    `要给出原因，不能只说 ok：${JSON.stringify(r.json)}`,
  );
  off?.();
});

/**
 * 栅栏接没接上 —— 这一层最容易"写了但没挂"。
 *
 * 单测（`fence.test.js`）只证明判定表是对的；这里证明 `route()` 真的调了它。
 * 两条都用同一份真实数据，只换请求头，排除别的变量。
 */
test('路由：非回环 Host 一律 403（局域网网页打不到本机面板）', async () => {
  const { call, off } = await bootHost({}, SEED);
  const ok = await call('/mind', { headers: { host: '127.0.0.1:17321' } });
  assert.equal(ok.status, 200, '前提：本机请求是通的');

  const bad = await call('/mind', { headers: { host: '192.168.1.9:17321' } });
  assert.equal(bad.status, 403, '换成本机以外的 Host 必须被拒');
  assert.equal(bad.json.ok, false);
  off?.();
});

test('路由：跨站标记 403，写接口同样拦住', async () => {
  const { call, off } = await bootHost({}, SEED);
  const bad = await call('/journal', {
    method: 'POST',
    body: { id: 'whatever' },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(bad.status, 403, 'POST /journal 是删日记的入口，跨站必须拒');
  off?.();
});
