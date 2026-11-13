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
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

/**
 * 路由层测试不该依赖真实网络。
 *
 * 本机若真跑着 Roost（默认 15207），`setup.api()` 会打到它，于是
 * 「连不上 roost」那几条断言会假红（2026-11-08 实测：本机 15207 在线，
 * `/account/scan` 的 `roost.ok` 变成 true，5 条测试挂掉）。
 * 整文件把 fetch 打死，测试可重复、也不受用户开着面板影响。
 */
globalThis.fetch = () => Promise.reject(
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { cause: { code: 'ECONNREFUSED' } }),
);

/**
 * 造一个假 ctx 并把 host 跑起来。
 * @param {object} cfgPatch 写进 config.json 的覆盖项
 */
async function bootHost(cfgPatch = {}, seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-routes-'));
  mkdirSync(dir, { recursive: true });
  /**
   * `cfgPatch` 也接受函数：有些配置项要写**绝对路径**（表情库目录），
   * 而临时目录是这里才建出来的，调用方事先不知道。
   */
  const patch = typeof cfgPatch === 'function' ? cfgPatch(dir) : cfgPatch;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(patch), 'utf8');
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
    const stale = [];
    for (const row of seed.journal) {
      const { invalid, ...rest } = row;
      j.add(rest);
      /** 种子里要「已作废」的行走真 invalidate，不手改库 */
      if (invalid) stale.push(rest.id);
    }
    if (stale.length) j.invalidate(stale, { supersededBy: 'seed' });
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

test('路由：/channels 的能力表如实声明（直连通道也不许虚报）', async () => {
  const { call, off } = await bootHost();
  const r = await call('/channels');
  assert.equal(r.json.ok, true);
  const caps = r.json.capabilities.roost ?? r.json.capabilities.qq;
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

test('用量：/usage 返回汇总结构，空库也不报错', async () => {
  const { call, off } = await bootHost({});
  const r = await call('/usage?days=7');
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.days), 'days 必须是数组');
  assert.ok(r.json.total && typeof r.json.total.turns === 'number', 'total.turns 要是个数');
  assert.equal(r.json.total.cost, undefined, '不做金额折算');
  assert.ok(r.json.chats && typeof r.json.chats === 'object');
  off?.();
});

/* ---------------- 账号迁移（路由层：真的接上了才算） ---------------- */

const OLD_OPENID = 'AAAA1111BBBB2222CCCC3333DDDD4444';

test('账号迁移：/account/scan 把记忆里的旧 openid 列出来', async () => {
  const { call, off } = await bootHost({}, {
    memory: { global: ['主人住在杭州'], chats: { [OLD_OPENID]: ['这个群叫我小离'] } },
    sessions: { [OLD_OPENID]: { sessionId: 's1', title: '倦飞之鸟', kind: 'c2c' } },
    journal: [{ chatId: OLD_OPENID, text: '今天聊了搬家', role: 'user', kind: 'chat', at: Date.now() }],
  });
  const r = await call('/account/scan');
  assert.equal(r.status, 200);
  const hit = r.json.items.find((x) => x.key === OLD_OPENID);
  assert.ok(hit, `扫描结果里没有 ${OLD_OPENID}：${JSON.stringify(r.json.items.map((x) => x.key))}`);
  assert.equal(hit.facts, 1, 'facts 条数要和 memory.json 对得上');
  assert.equal(hit.journal, 1, 'journal 条数要和库里对得上');
  assert.equal(hit.kind, 'c2c', '类型从 sessions.json 来');
  assert.equal(hit.title, '倦飞之鸟');
  /**
   * 测试环境没有 roost 在跑，所以 `roost.ok` 必须是 false ——
   * 但**列表照样要有**。这一条守的是「roost 挂了不能白屏」。
   */
  assert.equal(r.json.roost.ok, false);
  off?.();
});

test('账号迁移：/account/scan 空库也返回 200 + 空列表（新装用户的常态）', async () => {
  const { call, off } = await bootHost();
  const r = await call('/account/scan');
  assert.equal(r.status, 200, 'roost 挂了也不能让扫描接口 500');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.items, []);
  /**
   * 空列表时**不发反查请求**，所以 `roost.ok` 是 true——它只说明
   * 「这一批没有需要查的」，不说明 roost 活着。
   * 界面要判断「能不能绑定」得看 `/account/bots`，那条是真打 roost。
   */
  assert.equal(r.json.roost.ok, true);
  const b = await call('/account/bots');
  assert.equal(b.json.ok, false, '/account/bots 才是「roost 到底通不通」的信号');
  off?.();
});

test('账号迁移：/account/bound 和 /account/bots 连不上 roost 时给原因，不 500', async () => {
  const { call, off } = await bootHost();
  for (const p of ['/account/bound', '/account/bots']) {
    const r = await call(p);
    assert.equal(r.status, 200, `${p} 不该 500`);
    assert.equal(r.json.ok, false);
    assert.ok(r.json.error, `${p} 要说清为什么`);
  }
  off?.();
});

test('账号迁移：/account/bind 号码不合法 → 400，且不往下打请求', async () => {
  const { call, off } = await bootHost();
  const r = await call('/account/bind', {
    method: 'POST',
    body: { kind: 'user', uin: '01234', openid: OLD_OPENID },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID');
  off?.();
});

test('账号迁移：/account/attach 走的是同一个绑定实现（语义是追加）', async () => {
  const { call, off } = await bootHost();
  const r = await call('/account/attach', {
    method: 'POST',
    body: { kind: 'group', uin: '763366431', openid: OLD_OPENID },
  });
  /** 没 roost 可连 → 400 + 原因；关键是**路由通**、参数过了校验 */
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
  assert.notEqual(r.json.code, 'INVALID', '号码和 openid 都合法，不该被判非法');
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

  /**
   * 阶段 2 的配置骨架：字段和默认值先落地，功能分批上线（§18.3）。
   * 这几段对应的开关在 `features.js` 里还标着 `staged`，能力页不下发，
   * 设置页也不该提前列一个「改了什么都不会发生」的 JSON 块。
   *
   * 白名单不是永久豁免：下面按 id 反查 `staged`，功能上线时删掉那行
   * 就会让这条断言变红，逼着把段列进 `JSON_SECTIONS` 并移出白名单。
   */
  /**
   * §11 坑 2 / 门 G5：阶段 5 把最后一个骨架 `extensions` 上线，
   * 白名单清空、反查 for 删除，`extensions` 必须真的列进 `JSON_SECTIONS`。
   * 三处一起改，漏一处这条就红。
   */
  const NOT_SHIPPED = [];
  assert.deepEqual(NOT_SHIPPED, [], '阶段 5 后不该再有「后端有、设置页没有」的豁免段');
  const { FEATURES } = await import('../src/features.js');
  assert.equal(FEATURES.find((f) => f.id === 'extensions')?.staged, undefined,
    'extensions 已上线，不该还挂着 staged');
  assert.ok(keys.includes('extensions'), '设置页 JSON_SECTIONS 必须列出 extensions 配置段');
  /** profiles 已上线，配置段必须真的列在设置页（防止有人把 staged 加回去） */
  assert.equal(FEATURES.find((f) => f.id === 'profiles')?.staged, undefined,
    'profiles 已上线，不该还挂着 staged');
  /** moodEffects 已上线，配置段必须真的列在设置页（防止有人把上面那行 staged 加回去） */
  assert.equal(FEATURES.find((f) => f.id === 'moodEffects')?.staged, undefined,
    'moodEffects 已上线，不该还挂着 staged');
  assert.equal(FEATURES.find((f) => f.id === 'events')?.staged, undefined,
    'events 已上线，不该还挂着 staged');

  const missing = Object.keys(DEFAULTS).filter((k) => !keys.includes(k) && !NOT_SHIPPED.includes(k));
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

test('字段：/setup 的判据都在且是布尔，且不再探测 ai-chat', async () => {
  // 指一个不存在的目录：detect 就不会去连真实 Roost，测试与机器状态无关
  const { call, off } = await bootHost({ setup: { roostDir: join(tmpdir(), 'no-such-roost-xyz') } });
  const r = await call('/setup');
  assert.equal(r.status, 200, '/setup 不能 500');
  for (const k of ['installed', 'hasBot', 'running', 'hasCreds', 'ownersConfigured']) {
    assert.equal(typeof r.json[k], 'boolean', `${k} 必须是布尔`);
  }
  assert.equal(r.json.installed, false);
  assert.match(String(r.json.dirHow), /不是一份 Roost/);
  /** 移除 ai-chat 后这三个字段不许再回来：前端会拿它们推进度，回来就是假绿灯 */
  for (const k of ['pluginInstalled', 'pluginConfigured', 'pluginConfig']) {
    assert.equal(k in r.json, false, `${k} 不该还在 /setup 响应里`);
  }

  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  for (const k of ['installed', 'hasBot', 'hasCreds', 'dirHow']) {
    assert.ok(client.includes(k), `前端应该用到 ${k}`);
  }
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
 * 移除 ai-chat 的守卫：三条改插件配置的路由必须从注册表里消失。
 *
 * 用 bootHost 的 routes（真实路由表）而不是读源码字符串——
 * 只有注册表能证明「请求打进来确实没人接」。
 */
test('移除 ai-chat：/setup/plugin、/setup/configure、/setup/sync 三条路由已关闭', async () => {
  const { routes, call, off } = await bootHost();
  for (const p of ['/setup/plugin', '/setup/configure', '/setup/sync']) {
    assert.equal(routes.has('/roost/api' + p), false, `${p} 不该还在路由表里`);
  }
  /** bootHost 的 call() 遇到未注册路由会抛「路由没注册」，正好证明没人接 */
  await assert.rejects(
    () => call('/setup/sync', { method: 'POST', body: {} }),
    /路由没注册/,
    '旧地址必须没人接，不能静默当成成功',
  );
  /** 直连与向导路由一个都不能少 */
  for (const p of ['/roost/pair', '/roost/pair/enable', '/roost/pair/test',
                   '/setup/wizard', '/setup/wizard/done', '/setup/wizard/skip', '/setup/wizard/reopen']) {
    assert.ok(routes.has('/roost/api' + p), `缺路由 ${p}`);
  }
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

test('选人格：本群指定不动全局，A 群的指定不丢，取消能真的删掉', async () => {
  const h = await bootHost({ server: { token: 'REAL_TOKEN', port: 17321 }, persona: { current: 'default', byChat: { 群A: 'snarky' } } });
  try {
    const r1 = await h.call('/personas/use', { method: 'POST', body: { id: 'teacher', chatId: '群B' } });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.byChat.群A, 'snarky', 'A 群的指定不能丢');
    assert.equal(r1.json.byChat.群B, 'teacher');
    assert.equal(r1.json.current, 'default', '本群指定不该动全局');

    /**
     * `merge` 对对象是深合并，用 patch 删不掉键——所以 use/unuse 走整份写。
     * 这条就是锁这个行为的。
     */
    const r2 = await h.call('/personas/unuse', { method: 'POST', body: { chatId: '群B' } });
    assert.equal(r2.json.byChat.群B, undefined, '取消要真的删掉');
    assert.equal(r2.json.byChat.群A, 'snarky');

    /** 整份写最大的风险：把 token 冲掉。直接看磁盘 */
    const disk = JSON.parse(readFileSync(join(h.dir, 'config.json'), 'utf8'));
    assert.equal(disk.server.token, 'REAL_TOKEN', '换人格不能把 token 冲掉');
    assert.equal(disk.persona.byChat.群B, undefined);

    const bad = await h.call('/personas/use', { method: 'POST', body: { id: '不存在的' } });
    assert.equal(bad.status, 404);

    const blank = await h.call('/personas/use', { method: 'POST', body: { id: 'teacher', chatId: '   ' } });
    assert.equal(blank.status, 400, '传了空 chatId 不能悄悄当成改全局');
  } finally {
    h.off?.();
  }
});

test('治理：失效引用能查出来；批量删会级联清 byChat', async () => {
  const h = await bootHost({ persona: { current: 'default', byChat: { 群A: 'snarky', 群B: '不存在' } } });
  try {
    const g = await h.call('/personas/gov');
    assert.equal(g.json.invalid.length, 1, '只有 群B 是失效引用');
    assert.equal(g.json.health, null, '不扫时 health 必须是 null（面板显示未扫描）');

    const g2 = await h.call('/personas/gov?scan=1');
    assert.ok(g2.json.health, '扫描后要有结果');
    assert.ok(Array.isArray(g2.json.health.suggestions));

    const del = await h.call('/personas/batch/remove', { method: 'POST', body: { ids: ['snarky'] } });
    assert.equal(del.status, 200);
    assert.ok(del.json.batch, '要返回批次号');
    assert.equal(del.json.byChat.群A, undefined, '删掉被指定的要级联清 byChat');

    const undo = await h.call('/personas/batch/undo', { method: 'POST', body: { batch: del.json.batch } });
    assert.equal(undo.status, 200);
    assert.deepEqual(undo.json.restored, ['snarky']);

    const back = await h.call('/personas/gov');
    assert.equal(back.json.refs.find((r) => r.chatId === '群A')?.id, 'snarky', '撤销要把会话引用一起恢复');
  } finally {
    h.off?.();
  }
});

test('单删也会级联清 byChat', async () => {
  const h = await bootHost({ persona: { current: 'default', byChat: { 群A: 'snarky' } } });
  try {
    const r = await h.call('/personas/remove', { method: 'POST', body: { id: 'snarky' } });
    assert.equal(r.json.byChat.群A, undefined, '单删不级联的话这个群会一直指向不存在的人格');
  } finally {
    h.off?.();
  }
});

/**
 * 面板只提交自己那几项时，**不能把别的字段抹成默认值**。
 *
 * 2026-11 外部实测：DSH 的通用设置页保存一次，`speakUp.prompt`（105 字→空）、
 * `qqTools.maxParts`（5→3）、`persona.name`（杏奈→默认）、`tts.provider` 四项
 * 同时变回默认。用户能看到的只是「她变了个人」，日志里一个字都没有。
 *
 * 根因：路由默认走「整份替换」，而 `saveConfig` 的基线是 DEFAULTS ——
 * 没提交的键就是「删掉」，一律回落默认。现在默认改成局部合并。
 */
test('配置：不带 mode 的局部提交只改提交的那几项', async () => {
  const h = await bootHost({
    speakUp: { enabled: true, prompt: '恋人设定', minIntervalMinutes: 60, maxIntervalMinutes: 180, maxPerDay: 5 },
    qqTools: { enabled: true, maxParts: 5 },
    persona: { name: '杏奈' },
  });
  try {
    const r = await h.call('/config', { method: 'POST', body: { tts: { enabled: false } } });
    assert.equal(r.status, 200);
    const disk = JSON.parse(readFileSync(join(h.dir, 'config.json'), 'utf8'));
    assert.equal(disk.speakUp.prompt, '恋人设定', '没提交的 prompt 不许被抹');
    assert.equal(disk.speakUp.maxPerDay, 5, '同一个段里没提交的键也要保住');
    assert.equal(disk.qqTools.maxParts, 5, '没提交的 maxParts 不许被抹');
    assert.equal(disk.persona.name, '杏奈', '没提交的 persona.name 不许被抹');
    assert.equal(disk.tts.enabled, false, '提交了的要生效');

    // 显式整份模式：仍然是「删掉 = 回落默认」（配置全文编辑器靠这个）
    const full = await h.call('/config?mode=full', { method: 'POST', body: { tts: { enabled: true } } });
    assert.equal(full.status, 200);
    const after = JSON.parse(readFileSync(join(h.dir, 'config.json'), 'utf8'));
    assert.equal(after.qqTools.maxParts, 3, '整份模式：没提交的回落到默认');
    assert.equal(after.tts.enabled, true, '整份模式也照常写入提交的值');
  } finally {
    h.off?.();
  }
});

test('配置：整份保存带旧版本号会 409，不覆盖别处的修改', async () => {
  const h = await bootHost({ persona: { current: 'default' } });
  try {
    const g = await h.call('/config');
    const rev = g.json.revision;
    assert.ok(rev, 'GET /config 要返回版本号');

    const r1 = await h.call('/config', { method: 'POST', body: { persona: { current: 'snarky' }, __revision: rev } });
    assert.equal(r1.status, 200);

    // 用同一个旧版本号再存：磁盘已经变了，必须拒绝
    const r2 = await h.call('/config', { method: 'POST', body: { persona: { current: 'teacher' }, __revision: rev } });
    assert.equal(r2.status, 409, '旧快照不能覆盖');

    const disk = JSON.parse(readFileSync(join(h.dir, 'config.json'), 'utf8'));
    assert.equal(disk.persona.current, 'snarky', '磁盘上保留第一次保存的结果');
  } finally {
    h.off?.();
  }
});

test('治理体检：重复内容进建议，正在用的排除', async () => {
  const h = await bootHost({ persona: { current: 'default' } });
  try {
    const raw = '---\nlabel: 重复\n---\n同样的正文。';
    await h.call('/personas/save', { method: 'POST', body: { id: 'dup1', raw } });
    await h.call('/personas/save', { method: 'POST', body: { id: 'dup2', raw } });
    await h.call('/personas/use', { method: 'POST', body: { id: 'dup2', chatId: '群X' } });

    const g = await h.call('/personas/gov?scan=1');
    assert.ok(g.json.health.dup.length >= 1, '同内容要能判出重复');
    const sugg = g.json.health.suggestions.map((s) => s.id);
    assert.ok(!sugg.includes('dup2'), '被会话指定的不能进建议');
    assert.ok(sugg.includes('dup1'), '重复组里没被用的那个应该进建议');
    assert.ok(!sugg.includes('default'), '默认人格永远不进建议');
  } finally {
    h.off?.();
  }
});

test('配置：GET 读磁盘；旧版本号 409；成功后回新版本号', async () => {
  const h = await bootHost({ persona: { current: 'default' } });
  try {
    const g1 = await h.call('/config');
    const rev1 = g1.json.revision;

    // 模拟「别处改了配置」
    const p = join(h.dir, 'config.json');
    const c = JSON.parse(readFileSync(p, 'utf8'));
    c.persona.current = 'snarky';
    writeFileSync(p, JSON.stringify(c), 'utf8');

    const g2 = await h.call('/config');
    assert.equal(g2.json.config.persona.current, 'snarky', 'GET 必须读磁盘，不能回内存旧快照');
    assert.notEqual(g2.json.revision, rev1, '内容变了版本号就要变');

    const stale = await h.call('/config', { method: 'POST', body: { persona: { current: 'teacher' }, __revision: rev1 } });
    assert.equal(stale.status, 409);

    const ok = await h.call('/config', { method: 'POST', body: { persona: { current: 'teacher' }, __revision: g2.json.revision } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.revision && ok.json.revision !== g2.json.revision, '成功要回新版本号');
  } finally {
    h.off?.();
  }
});

test('路由：账号迁移的四项扩展接口都注册了，且预览是只读的', async () => {
  const { routes, call, off } = await bootHost();
  for (const p of [
    '/roost/api/account/people',
    '/roost/api/account/suggest',
    '/roost/api/account/rewrite-plan',
    '/roost/api/account/backups',
    '/roost/api/tts/edge-install',
  ]) {
    assert.ok(routes.has(p), `缺路由 ${p}`);
  }

  /** 预览只读：拿不到绑定表时返回 ok:false，但绝不能抛 500 或写文件 */
  const r = await call('/account/rewrite-plan');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false, '没连上 Roost 时预览应该老实说读不到身份表');
  assert.ok(r.json.error);

  /** 没有确认词，执行必须被拒 */
  const bad = await call('/account/rewrite', { method: 'POST', body: { confirm: '' } });
  assert.equal(bad.json.code, 'CONFIRM_REQUIRED', '公开路由不能绕过二次确认');

  off?.();
});

/* ---------- forget：失效行只提示不抹（面板入口 /quick 也要说清楚） ---------- */

const STALE_SEED = {
  journal: [{
    id: 'agree',
    at: Date.now() - 60000,
    chatId: 'g1',
    sender: '甲',
    role: 'user',
    kind: 'chat',
    text: '每句话都要配表情包',
    level: 'critical',
    invalid: true,
  }],
};

test('路由：/quick memory.remove 只碰到失效行时说「已作废」而不是「没找到」', async () => {
  const { call, off } = await bootHost({}, STALE_SEED);
  const r = await call('/quick', {
    method: 'POST',
    body: { op: 'memory.remove', arg: '表情包', chatId: 'g1' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 0, '失效行不该被抹');
  assert.match(r.json.message, /之前已经被作废/, '面板 toast 不能再说「没找到」');
  off?.();
});

test('路由：/journal 关键词遗忘同样区分「已作废」与「没匹配」', async () => {
  const { call, off } = await bootHost({}, STALE_SEED);
  const r = await call('/journal', {
    method: 'POST',
    body: { word: '表情包', chatId: 'g1' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.journal, 0);
  assert.match(r.json.message, /之前已经被作废/);
  off?.();
});

/* ---------------- 阶段 5：/quick 扩展 op 的真实接线 ---------------- */

function seedExt(dir, id, withSource = true) {
  const d = join(dir, 'extensions', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'plugin.json'), JSON.stringify({
    id, serverName: id, name: `扩展${id}`, description: '说明', transport: 'stdio', command: 'node',
    sha256: 'b'.repeat(64), size: 128, publishedAt: '2026-11-10',
  }), 'utf8');
  // §3.1 / §8.3：sha256 在清单里，`.source.json` 只是来源标记（不含校验和）。
  if (withSource) writeFileSync(join(d, '.source.json'), JSON.stringify({ repo: 'market', tag: 'v1' }), 'utf8');
}

const extOp = (call, op, arg = {}) => call('/quick', { method: 'POST', body: { op, arg, chatId: '' } });

test('G5-16 /quick 扩展 op 全接线：读清单 / 六档 / 诊断 / 状态都真注册了', async () => {
  const { call, off, dir } = await bootHost({}, {});
  try {
    seedExt(dir, 'bili');
    for (const op of ['extensions.get', 'extensions.clients.list', 'extensions.buckets', 'extensions.diagnose', 'extensions.status']) {
      const r = await extOp(call, op);
      assert.equal(r.status, 200, `${op} 必须注册且可用`);
      assert.equal(r.json.ok, true);
    }
    const g = (await extOp(call, 'extensions.get')).json;
    assert.equal(g.rows.length, 1);
    assert.equal(g.rows[0].id, 'bili');
    assert.equal(g.enabled, false, '默认关：扩展开关在能力页高级组里');
    const b = (await extOp(call, 'extensions.buckets')).json;
    assert.equal(b.buckets.length, 6);
    assert.equal(b.fallback.degraded, true, '宿主探针读真实 speaker 表：没有活跃会话就该报退化');
    // 假 ctx 没有观察到的工具池时如实回 null，不假装算过；有池子才用真实策略算。
    assert.ok(b.fallback.allowCount === null || Number.isFinite(b.fallback.allowCount));
    const d = (await extOp(call, 'extensions.diagnose')).json;
    assert.deepEqual(d.layers.map((L) => L.id), ['fence', 'capabilities', 'quota', 'acl', 'guard']);
  } finally { off?.(); }
});

test('G5-17 /quick usage.save：市场装扩展编辑后 sha256 失效，面板拿得到标注', async () => {
  const { call, off, dir } = await bootHost({}, {});
  try {
    seedExt(dir, 'bili');
    const saved = await extOp(call, 'extensions.usage.save', { id: 'bili', usage: '改过的说明' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.invalidated, true);
    const disk = JSON.parse(readFileSync(join(dir, 'extensions', 'bili', 'plugin.json'), 'utf8'));
    assert.equal(disk.sha256, null, '清单校验和必须失效');
    assert.equal(disk.locallyModified, true);
    const src = JSON.parse(readFileSync(join(dir, 'extensions', 'bili', '.source.json'), 'utf8'));
    assert.equal(src.repo, 'market');
    assert.equal(src.locallyModified, true);
    const row = (await extOp(call, 'extensions.get')).json.rows[0];
    assert.equal(row.usage, '改过的说明');
    assert.match(row.label, /已本地修改/);
    assert.equal(row.sha256Valid, false);
  } finally { off?.(); }
});

test('G5-18 /quick 客户端：发放 / 列表不回 hash / 吊销 / 坏 scope 400', async () => {
  const { call, off } = await bootHost({}, {});
  try {
    const blocked = await extOp(call, 'extensions.clients.create', { name: '裁判', scopes: ['agent:write'] });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.reason, 'needs_confirm', '高权限 scope 要二次确认');
    const made = await extOp(call, 'extensions.clients.create', {
      name: '裁判', scopes: ['agent:write'], confirm: true,
    });
    assert.equal(made.status, 200);
    assert.ok(made.json.token.length >= 30);
    const listed = (await extOp(call, 'extensions.clients.list')).json;
    const one = listed.rows.find((r) => r.id === made.json.id);
    assert.ok(one);
    assert.equal(one.hash, undefined);
    assert.equal(one.token, undefined);
    assert.ok(listed.availableScopes.includes('agent:write'));
    const bad = await extOp(call, 'extensions.clients.create', { scopes: ['nope'] });
    assert.equal(bad.status, 400);
    const revoked = await extOp(call, 'extensions.clients.revoke', { id: made.json.id });
    assert.equal(revoked.status, 200);
    assert.equal((await extOp(call, 'extensions.clients.list')).json.rows.some((r) => r.id === made.json.id), false);
  } finally { off?.(); }
});

test('G7-1 capabilities.init 真合并影子组：启用后 group:ext_bili 存在（8b 主落点 host 级）', async () => {
  const { call, off, dir } = await bootHost({}, {});
  try {
    seedExt(dir, 'bili');
    // 模拟「市场装完、能力页还没启用」：只有 ext-groups.json
    mkdirSync(join(dir, 'extensions'), { recursive: true });
    writeFileSync(join(dir, 'extensions', 'ext-groups.json'), JSON.stringify({
      version: 1,
      groups: { ext_bili: { match: ['mcp__bili__*'], label: 'B站' } },
      memberAllow: ['group:ext_bili'],
      adminAllow: ['ext_memory_note'],
    }), 'utf8');

    const r = await extOp(call, 'capabilities.init');
    assert.equal(r.status, 200);
    const caps = JSON.parse(readFileSync(join(dir, 'capabilities.json'), 'utf8'));
    assert.ok(caps.groups.ext_bili, '影子组必须合并进 seed —— 不合并就是启用后群友静默断档');
    assert.ok(caps.groups.mcp, '默认组不能被影子组整块冲掉');
    assert.ok(caps.defaults.member.allow.includes('group:ext_bili'));
    assert.ok(caps.defaults.admin.allow.includes('ext_memory_note'));
  } finally { off?.(); }
});

test('G5-21 /quick 清空扩展记忆：要显式确认，只删 ext-memory 单文件', async () => {
  const { call, off, dir } = await bootHost({}, {});
  try {
    seedExt(dir, 'bili');
    const memDir = join(dir, 'ext-memory');
    mkdirSync(memDir, { recursive: true });
    const file = join(memDir, 'bili.json');
    writeFileSync(file, JSON.stringify({ version: 1, rows: [{ text: 'x' }], meta: { onClear: 'clear' } }), 'utf8');
    assert.equal((await extOp(call, 'extensions.memory.clear')).status, 400, '破坏性操作必须显式确认');
    assert.equal(existsSync(file), true);
    const r = await extOp(call, 'extensions.memory.clear', { confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.cleared, 1);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(dir, 'extensions', 'bili', 'plugin.json')), true, '清单不能跟着被删');
  } finally { off?.(); }
});

test('G5-19 /quick status：面板两个状态只由后端审计事件点亮', async () => {
  const { call, off, dir } = await bootHost({}, {});
  try {
    assert.equal((await extOp(call, 'extensions.status')).json.authFailed, false);
    writeFileSync(join(dir, 'audit.log'), [
      JSON.stringify({ op: 'ext.auth_failed', note: 'bili', at: 1 }),
      JSON.stringify({ op: 'ext.token_regenerated', note: 'bili', at: 2 }),
      JSON.stringify({ op: 'v1.waiting-credentials', note: '不算', at: 3 }),
    ].join('\n') + '\n', 'utf8');
    const s = (await extOp(call, 'extensions.status')).json;
    assert.equal(s.authFailed, true);
    assert.equal(s.regenerated, true);
    assert.equal(s.hintAuthFailed, '扩展鉴权失败');
    assert.equal(s.hintRegenerated, '令牌已重新生成');
  } finally { off?.(); }
});

/* ---------------- 更新：默认只读后台快照 ---------------- */

test('路由：更新检查默认只读快照，没查过时返回 pending（不冒充「已是最新」）', async () => {
  const { call, off } = await bootHost();
  try {
    const r = await call('/update/check');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.pending, true, '后台还没查完必须说 pending，不能返回 hasUpdate:false');
    assert.ok(r.json.own, '当前版本要带上，面板才知道显示什么');
  } finally {
    off?.();
  }
});

test('路由：force=1 才真的去查（测试里网络被掐死，如实报错）', async () => {
  const { call, off } = await bootHost();
  try {
    const r = await call('/update/check?force=1');
    assert.equal(r.json.ok, true, '查不到最新版也是 200，不能让整块变成错误页');
    assert.match(String(r.json.error || ''), /ECONNREFUSED|connect/, '要把真实原因带出来，别吞掉');
  } finally {
    off?.();
  }
});

test('路由：更新说明取的是当前版本那一段', async () => {
  const { call, off } = await bootHost();
  try {
    const r = await call('/update/notes');
    assert.equal(r.json.ok, true);
    assert.match(r.json.notes, /一句话/, 'RELEASE_NOTES.md 里当前版本那段要被取出来');
  } finally {
    off?.();
  }
});

/* ---------------- 模型三层（2026-11-13：面板改成从 DSH 清单里选） ---------------- */

const modelOp = (call, op, arg = {}) => call('/quick', {
  method: 'POST',
  body: { op, arg, chatId: '' },
});

test('路由：model.set 的四个入口各改各的，互不串台', async () => {
  const { call, dir, off } = await bootHost();

  /** ① 所有聊天的默认模型 */
  let r = await modelOp(call, 'model.set', { default: { provider: 'p1', model: 'm1' } });
  assert.equal(r.json.ok, true);
  /** ② 全局思考强度 */
  r = await modelOp(call, 'model.set', { effort: 'low' });
  assert.equal(r.json.ok, true);
  /** ③ 群聊类型默认 */
  r = await modelOp(call, 'model.set', { kind: 'group', provider: 'p2', model: 'm2' });
  assert.equal(r.json.ok, true);
  /**
   * ④ 单个聊天，**同时带 kind**。
   *
   * 面板「添加例外」就是这么发的（它知道这个聊天是私聊还是群）。
   * 以前 `if (kind)` 会掉进 byKind 分支，把**所有**私聊都改成 p3——
   * 面板上看起来只改了一个，实际影响一片。
   */
  r = await modelOp(call, 'model.set', { chatId: 'g1', kind: 'c2c', provider: 'p3', model: 'm3' });
  assert.equal(r.json.ok, true);

  const g = await modelOp(call, 'model.get', {});
  assert.deepEqual(g.json.defaultSel, { provider: 'p1', model: 'm1' });
  assert.equal(g.json.effort, 'low');
  assert.equal(g.json.byKindAll.group.model, 'm2');
  assert.deepEqual(g.json.byKindAll.c2c, {}, '带 chatId 时绝不能把所有私聊都改掉');
  assert.equal(g.json.byChat.g1.model, 'm3');
  assert.equal(g.json.byChat.g1.kind, 'c2c', '面板要用它标「私聊 / 群」');

  /** 落到磁盘上的形状也要对：pruneTo 会把不在 DEFAULTS 里的键裁掉 */
  const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(saved.model.default, { provider: 'p1', model: 'm1' });
  assert.equal(saved.model.effort, 'low');
  assert.equal(saved.model.byChat.g1.provider, 'p3');

  /** 清掉 / 恢复：默认模型回 {}，单个聊天整条删掉 */
  await modelOp(call, 'model.set', { default: { off: true } });
  await modelOp(call, 'model.set', { chatId: 'g1', off: true });
  const g2 = await modelOp(call, 'model.get', {});
  assert.deepEqual(g2.json.defaultSel, {});
  assert.equal(g2.json.byChat.g1, undefined, '删掉的键不能被深合并合回来');
  off?.();
});

test('路由：宿主没有 ctx.llm 时清单给一句人话，不是 500', async () => {
  const { call, off } = await bootHost();
  const r = await modelOp(call, 'model.list', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.message), /ctx\.llm|模型清单/);
  assert.deepEqual(r.json.list, [], '面板要能拿着空清单退回手填');

  const p = await modelOp(call, 'model.ping', { provider: 'p1', model: 'm1' });
  assert.equal(p.json.ok, false);
  assert.ok(String(p.json.message).length > 0, '测速失败也要有原因');

  const bad = await modelOp(call, 'model.ping', {});
  assert.equal(bad.status, 400, '缺 provider/model 直接 400');
  off?.();
});

/**
 * 5.7 模拟测试：真打一次 `/simulate/run`。
 *
 * 纯函数测试（`simulate.test.js`）保证算法对，这里只保证「接上了、没真发」：
 * 断言返回 6 层、私聊会回、群里没 @ 不回、响应里带假身份清单。
 */
test('路由：/simulate/run 跑通六层，私聊会回、群里没 @ 不回', async () => {
  const { call, off } = await bootHost({ roostHost: { decide: { mode: 'mention' } } });

  const c2c = await call('/simulate/run', { method: 'POST', body: { text: '在吗', kind: 'c2c' } });
  assert.equal(c2c.status, 200);
  assert.equal(c2c.json.ok, true);
  assert.deepEqual(
    c2c.json.steps.map((s) => s.layer),
    ['inbound', 'decide', 'model', 'tools', 'outbound', 'ledger'],
  );
  assert.equal(c2c.json.verdict, 'reply');
  assert.equal(c2c.json.ledger.dry, true, '模拟永远标 dry');
  assert.equal(c2c.json.ledger.wouldWrite, true);
  assert.ok(Array.isArray(c2c.json.personas) && c2c.json.personas.length >= 3, '面板要能拿到假身份清单');

  const group = await call('/simulate/run', {
    method: 'POST', body: { text: '今天好热', kind: 'group', mentioned: false },
  });
  assert.equal(group.status, 200);
  assert.equal(group.json.verdict, 'silent');
  const decide = group.json.steps.find((s) => s.layer === 'decide');
  assert.match(decide.reason, /只在被 @ 时回复/);
  assert.equal(group.json.outbound.willSend, false);
  assert.equal(group.json.ledger.wouldWrite, false, '不发就不该记账');

  off?.();
});

test('路由：/simulate/run 超长文本直接 413，不硬算', async () => {
  const { call, off } = await bootHost();
  const r = await call('/simulate/run', { method: 'POST', body: { text: 'x'.repeat(2001) } });
  assert.equal(r.status, 413);
  assert.equal(r.json.ok, false);
  off?.();
});

/** 5.9 扩展向导：生成 → 真能读回 → 同名不覆盖 */
test('路由：/extensions/scaffold 生成骨架，同名再生成 409 不覆盖', async () => {
  const { call, off } = await bootHost();

  const r = await call('/extensions/scaffold', {
    method: 'POST',
    body: {
      id: 'wizard-demo', name: '向导演示', description: '演示用',
      transport: 'stdio', tools: [{ name: 'ping', description: '测试一下' }],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, 'wizard-demo');
  assert.deepEqual(r.json.files, ['plugin.json', 'server.mjs']);
  assert.ok(existsSync(join(r.json.dir, 'plugin.json')), '清单要真的落盘');
  assert.ok(existsSync(join(r.json.dir, 'server.mjs')), 'stdio 形态要带可跑的 server');
  assert.equal(existsSync(join(r.json.dir, '.source.json')), false, '不能标成市场装的');
  assert.ok(Array.isArray(r.json.next) && r.json.next.length, '要给出下一步动作');

  /** 再来一次：目录已存在 → 409，且不覆盖原文件 */
  const again = await call('/extensions/scaffold', {
    method: 'POST',
    body: { id: 'wizard-demo', name: '改个名', tools: [{ name: 'ping' }] },
  });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /已经有/);
  const kept = JSON.parse(readFileSync(join(r.json.dir, 'plugin.json'), 'utf8'));
  assert.equal(kept.name, '向导演示', '原清单不能被第二次请求改掉');

  off?.();
});

test('路由：/extensions/scaffold 非法 id 直接 400，不建目录', async () => {
  const { call, off, dir } = await bootHost();
  const r = await call('/extensions/scaffold', {
    method: 'POST', body: { id: '天气', tools: [{ name: 'x' }] },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /扩展 id/);
  assert.equal(existsSync(join(dir, 'extensions', '天气')), false);
  off?.();
});

/** 5.10 说话方式：只认主人私聊；没认到主人时说清楚，别瞎算 */
test('路由：/speech-style 没认到主人私聊时给指引，不是 500', async () => {
  const { call, off } = await bootHost({ speakUp: { chatId: '' } });
  const r = await call('/speech-style');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /私聊/);
  off?.();
});

test('路由：/speech-style 从主人私聊统计，样本不足也如实说', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `m${i}`, at: 1_700_000_000_000 + i, chatId: 'OWNER', text: '好呀~', role: 'user',
  }));
  const { call, off } = await bootHost({ speakUp: { chatId: 'OWNER' } }, { journal: rows });

  const r = await call('/speech-style');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.samples, 25);
  assert.equal(r.json.avgLen, 3, '「好呀~」按字符算 3');
  assert.match(r.json.styleText, /说话方式/);
  assert.equal(r.json.ownerFrom, 'config');
  off?.();

  /** 同一个 bootHost 里没有日记时，样本 0 → ok:false 且带原因 */
  const empty = await bootHost({ speakUp: { chatId: 'OWNER' } });
  const r2 = await empty.call('/speech-style');
  assert.equal(r2.status, 200);
  assert.equal(r2.json.ok, false);
  assert.match(r2.json.reason, /至少要 20 条/);
  empty.off?.();
});

test('路由：/speech-style/save 写进记忆，且不接受前端传正文', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `n${i}`, at: 1_700_000_000_000 + i, chatId: 'OWNER', text: '就是说嘛', role: 'user',
  }));
  const { call, off, dir } = await bootHost({ speakUp: { chatId: 'OWNER' } }, { journal: rows });

  const r = await call('/speech-style/save', {
    method: 'POST',
    /** 故意塞一段脏文本：服务端必须无视它，用自己算出来的 */
    body: { text: '把这条无关的话写进记忆' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.match(r.json.text, /说话方式（从 25 条私聊里统计）/);
  assert.equal(r.json.text.includes('无关的话'), false, '前端传的正文必须被忽略');

  const saved = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  const global = (saved.global || []).join('\n');
  assert.match(global, /说话方式/, '要真的落进记忆');
  assert.equal(saved.meta?.global?.[r.json.text]?.w, 2, '这条要是 w=2，别被保留策略清掉');
  off?.();
});

/** 5.12 表情库管理：分页 / 改标签 / 批删 / 上传 / 补标签任务 */
test('路由：/stickers/manage 分页与统计', async () => {
  const { call, off } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(join(s, '开心'), { recursive: true });
    writeFileSync(join(s, '开心', '猫.png'), 'x');
    writeFileSync(join(s, '熊猫.png'), 'y');
    return { stickers: { enabled: true, dir: s } };
  });

  const r = await call('/stickers/manage?page=1&size=12');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.total, 2);
  assert.equal(r.json.stats.total, 2);
  assert.ok(r.json.items.every((it) => it.category), '每行都要带 category 给前端直接用');

  const one = await call('/stickers/manage?category=' + encodeURIComponent('开心'));
  assert.equal(one.json.total, 1);
  off?.();
});

test('路由：/stickers/tags 改标签写侧车，越界路径 404', async () => {
  const { call, off, dir } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(s, { recursive: true });
    writeFileSync(join(s, '猫.png'), 'x');
    return { stickers: { enabled: true, dir: s } };
  });

  const r = await call('/stickers/tags', { method: 'POST', body: { file: '猫.png', tags: ['开心', '猫'], note: '装可爱时' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.tags, ['开心', '猫']);
  assert.equal(
    readFileSync(join(dir, 'stickers', '猫.png.tags'), 'utf8').trim(),
    '开心, 猫; 装可爱时',
  );

  const bad = await call('/stickers/tags', { method: 'POST', body: { file: '../../memory.json', tags: ['x'] } });
  assert.equal(bad.status, 404, '越界路径必须被 locate() 挡住');
  off?.();
});

test('路由：/stickers/delete 要 confirm，删完图与侧车都不在', async () => {
  const { call, off, dir } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(s, { recursive: true });
    writeFileSync(join(s, '猫.png'), 'x');
    writeFileSync(join(s, '猫.png.tags'), '猫');
    return { stickers: { enabled: true, dir: s } };
  });

  const no = await call('/stickers/delete', { method: 'POST', body: { files: ['猫.png'] } });
  assert.equal(no.status, 400);
  assert.equal(existsSync(join(dir, 'stickers', '猫.png')), true);

  const yes = await call('/stickers/delete', { method: 'POST', body: { files: ['猫.png'], confirm: true } });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.deepEqual(yes.json.removed, ['猫.png']);
  assert.equal(existsSync(join(dir, 'stickers', '猫.png')), false);
  assert.equal(existsSync(join(dir, 'stickers', '猫.png.tags')), false);
  off?.();
});

test('路由：/stickers/upload 收 base64，重名加序号不覆盖', async () => {
  const { call, off, dir } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(s, { recursive: true });
    writeFileSync(join(s, '猫.png'), 'old');
    return { stickers: { enabled: true, dir: s } };
  });

  const data = Buffer.from('new-image').toString('base64');
  const r = await call('/stickers/upload', { method: 'POST', body: { name: '猫.png', data } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.file, '猫-1.png', '同名要加序号，不能盖掉已有的');
  assert.equal(readFileSync(join(dir, 'stickers', '猫.png'), 'utf8'), 'old', '原文件一个字都不能动');
  assert.equal(readFileSync(join(dir, 'stickers', '猫-1.png'), 'utf8'), 'new-image');

  const bad = await call('/stickers/upload', { method: 'POST', body: { name: 'x.exe', data } });
  assert.equal(bad.status, 400, '只收图片扩展名');
  off?.();
});

test('路由：/stickers/tags/fill 起任务并跑到完成', async () => {
  const { call, off, dir } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(join(s, '开心'), { recursive: true });
    writeFileSync(join(s, '开心', '熊猫.png'), 'x');
    writeFileSync(join(s, '开心', '猫.png'), 'y');
    return { stickers: { enabled: true, dir: s } };
  });

  const start = await call('/stickers/tags/fill', { method: 'POST', body: { all: false } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.total, 2);

  /** 任务每 60ms 跑一片，轮询等它结束 */
  let job = null;
  for (let i = 0; i < 40; i += 1) {
    const p = await call('/stickers/tags/job');
    job = p.json.job;
    if (job && !job.running) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(job, '要能查到任务进度');
  assert.equal(job.done, 2);
  assert.equal(job.failed, 0);
  assert.equal(job.percent, 100);

  /** 侧车写出来了，且标签里带分类名 */
  const side = readFileSync(join(dir, 'stickers', '开心', '猫.png.tags'), 'utf8');
  assert.match(side, /开心/);
  off?.();
});

/**
 * 真机 bug 回归（2026-11-14）：「同步缓存图」在库里建了真名叫 `未分类` 的子目录，
 * 而 `未分类` 又是根目录图的显示名，于是这类图「列表里有、缩略图破、删不掉」。
 */
test('路由：/stickers/delete 能删「未分类」子目录里的图（显示名 ≠ 目录名）', async () => {
  const { call, off, dir } = await bootHost((d) => {
    const s = join(d, 'stickers');
    mkdirSync(join(s, '未分类'), { recursive: true });
    writeFileSync(join(s, '未分类', '缓存.jpg'), 'x');
    writeFileSync(join(s, '海妖.png'), 'y');
    return { stickers: { enabled: true, dir: s } };
  });

  /** 列表要能看到它，且 rel 带分类前缀 */
  const list = await call('/stickers/manage');
  const row = list.json.items.find((it) => it.file === '缓存.jpg');
  assert.ok(row, '列表里应该有这张');
  assert.equal(row.rel, '未分类/缓存.jpg');
  assert.equal(row.category, '未分类');

  const r = await call('/stickers/delete', {
    method: 'POST', body: { files: ['未分类/缓存.jpg'], confirm: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.removed, ['未分类/缓存.jpg'], '以前这里会报「不在表情库里」');
  assert.equal(existsSync(join(dir, 'stickers', '未分类', '缓存.jpg')), false);

  /** 根目录那张不能被连带删掉 */
  assert.equal(existsSync(join(dir, 'stickers', '海妖.png')), true);
  off?.();
});

/* ---------------- 自驱引擎（实验，默认关） ---------------- */

test('路由：/autotelic/status 默认关着，think 被拒且留痕', async () => {
  const { call, off, dir } = await bootHost({});

  const s = await call('/autotelic/status');
  assert.equal(s.status, 200);
  assert.equal(s.json.enabled, false, '默认必须关');
  assert.equal(s.json.ledger.chain.ok, true, '空账本也算链完整');
  assert.equal(s.json.cfg.seeds.length, 0);

  const t = await call('/autotelic/think', { method: 'POST', body: {} });
  assert.equal(t.status, 409, '状态不允许用 409，不是 400');
  assert.match(t.json.reason, /没开/);

  /** 拒绝也要进账本：不然「为什么她什么都不做」查不出来 */
  const recent = await call('/autotelic/recent');
  assert.equal(recent.json.rows[0].kind, 'deny');
  off?.();
});

test('路由：/autotelic/seeds 存种子并落盘', async () => {
  const { call, off, dir } = await bootHost({});
  const r = await call('/autotelic/seeds', {
    method: 'POST', body: { seeds: ['  想想怎么说话  ', '', 'A'.repeat(300)] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.seeds, ['想想怎么说话', 'A'.repeat(200)], '去空、夹到 200 字');

  const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(saved.autotelic.seeds, r.json.seeds);
  off?.();
});

test('路由：开了之后立项成功，账本链可验；推进失败会计数', async () => {
  const { call, off, dir } = await bootHost({ autotelic: { enabled: true, seeds: ['想想怎么把话说明白'] } });

  const t = await call('/autotelic/think', { method: 'POST', body: {} });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.project.text, '想想怎么把话说明白');

  const s1 = await call('/autotelic/status');
  assert.equal(s1.json.today.projects, 1);
  assert.equal(s1.json.ledger.chain.ok, true);
  assert.equal(s1.json.project.text, '想想怎么把话说明白');

  /**
   * 假 ctx 的 agent 没有 prompt()/run()，所以推进必然失败——
   * 正好验「失败要记进账本 + 计数」，而不是静默吞掉。
   */
  const step = await call('/autotelic/step', { method: 'POST', body: {} });
  assert.equal(step.status, 409);
  assert.match(step.json.reason, /失败/);

  const s2 = await call('/autotelic/status');
  assert.equal(s2.json.failures, 1);
  assert.equal(s2.json.ledger.chain.ok, true, '失败记录也要接得上链');
  off?.();
});

test('路由：/autotelic/preview 只算不记账', async () => {
  const { call, off, dir } = await bootHost({ autotelic: { enabled: true, seeds: ['A', 'B'] } });
  const p = await call('/autotelic/preview');
  assert.equal(p.status, 200);
  assert.ok(['A', 'B'].includes(p.json.project.text));

  const recent = await call('/autotelic/recent');
  assert.deepEqual(recent.json.rows, [], '预览不该写账本');
  off?.();
});
