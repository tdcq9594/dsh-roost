/**
 * 扩展人格接口（`/v1/personas*` + `/v1/session.configure`）
 *
 * 守的是三类事：
 *   1. **能力完整**：列 / 读 / 改 / 建 / 删 / 切 六件事都在，缺一个扩展就只能干一半
 *      （用户原话：「没有修改人格接口」→ 补完后又问「新建人格呢」）；
 *   2. **不会静默做错**：save 不顺手新建、create 不顺手覆盖、remove 不静默删、
 *      chatId 传空串不当成「改全局」——这几条每一条都能让主人看不出发生了什么；
 *   3. **写配置的基线是磁盘**：内存 `cfg` 可能是几小时前的快照，拿它整份写会把
 *      用户运行期手改的 `config.json` 回滚掉。
 *
 * 跑法：node --test test/ext-persona.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExtPersona, composePersonaText, normalizeModelSpec, MAX_PERSONA_CHARS, MAX_CHAT_ID,
} from '../src/ext-persona.js';

/** 内存版人格库，行为对齐 `createPersonas()` 里被用到的那几个方法 */
function makeStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    list: () => [...files.keys()].map((id) => ({
      id, label: id, name: id, selfName: '', tags: [], chars: Array.from(files.get(id)).length,
    })),
    read: (id) => (files.has(id)
      ? { id, label: id, name: id, selfName: '', tags: [], raw: files.get(id) }
      : null),
    save: (id, raw) => {
      /** 真实现里 `safeId` 会拒绝含分隔符的 id */
      if (/[/\\]/.test(id)) throw new Error('id 里不能有路径分隔符');
      files.set(id, raw);
      return { id };
    },
    remove: (id) => {
      if (id === 'default') throw new Error('默认人格不能删');
      if (!files.has(id)) return { id, skipped: true };
      files.delete(id);
      return { id };
    },
  };
}

/** 内存配置 + **独立的磁盘副本**，用来验证「基线取磁盘」 */
function makeCfg({ mem = {}, disk = null } = {}) {
  const state = {
    mem: structuredClone(mem),
    disk: structuredClone(disk ?? mem),
  };
  return {
    state,
    cfgOf: () => state.mem,
    loadDiskCfg: () => structuredClone(state.disk),
    saveCfg: (next) => { state.mem = next; state.disk = structuredClone(next); return next; },
  };
}

const baseCfg = () => ({
  persona: { current: 'default', byChat: {}, name: '大肥鱼' },
  model: { default: {}, byChat: {} },
  speakUp: { prompt: '原样' },
});

function build({ store, cfg, clearRefs = () => {}, onSwitched = null, log = null } = {}) {
  const switched = [];
  const removed = [];
  const logs = [];
  const api = createExtPersona({
    personas: store,
    cfgOf: cfg.cfgOf,
    loadDiskCfg: cfg.loadDiskCfg,
    saveCfg: cfg.saveCfg,
    clearRefs: (ids) => { removed.push(...ids); clearRefs(ids); },
    onSwitched: (info) => { switched.push(info); if (onSwitched) onSwitched(info); },
    log: (m) => { logs.push(m); if (log) log(m); },
  });
  return { api, switched, removed, logs };
}

/* ── 1. composePersonaText ───────────────────────────────────────────── */

test('P1 composePersonaText：没头就补，有头就原样', () => {
  assert.equal(composePersonaText({ raw: '正文' }), '正文', '什么都没给就不该凭空加头');
  assert.equal(
    composePersonaText({ raw: '正文', label: '小美' }),
    '---\nlabel: 小美\n---\n\n正文',
  );
  assert.equal(
    composePersonaText({ raw: '正文', label: '小美', selfName: '若叶睦', tags: ['傲娇', '学生'] }),
    '---\nlabel: 小美\nselfName: 若叶睦\ntags: 傲娇, 学生\n---\n\n正文',
  );
  /** 自带 frontmatter（从别处拷来的角色卡）不能加第二个头 */
  const own = '---\nlabel: 别人\n---\n\n正文';
  assert.equal(composePersonaText({ raw: own, label: '小美' }), own);
});

test('P2 composePersonaText：值里的换行会被压平，撑不断头部', () => {
  const out = composePersonaText({ raw: 'x', label: 'a\nb' });
  assert.equal(out, '---\nlabel: a b\n---\n\nx');
});

test('P3 normalizeModelSpec：只认三个键，effort 只认三档', () => {
  assert.equal(normalizeModelSpec(null), null);
  assert.equal(normalizeModelSpec({}), null);
  assert.equal(normalizeModelSpec({ foo: 1 }), null);
  assert.deepEqual(normalizeModelSpec({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(normalizeModelSpec({ reasoningEffort: 'high' }), { reasoningEffort: 'high' });
  assert.equal(normalizeModelSpec({ reasoningEffort: 'turbo' }), null, '不认识的档位不该落盘');
});

/* ── 2. personas.list / read ─────────────────────────────────────────── */

test('P4 list：给行但不给正文；current / effective / byChat 都对', async () => {
  const store = makeStore({ default: '默认', cat: '猫娘正文' });
  const cfg = makeCfg({ mem: { ...baseCfg(), persona: { current: 'cat', byChat: { g1: 'default' }, name: 'x' } } });
  const { api } = build({ store, cfg });

  const r = await api['personas.list']({ query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.current, 'cat');
  assert.equal(r.body.effective, 'cat');
  assert.deepEqual(r.body.byChat, { g1: 'default' });
  assert.deepEqual(r.body.rows.map((x) => x.id).sort(), ['cat', 'default']);
  assert.ok(!('raw' in r.body.rows[0]), '列表不该带正文');

  const scoped = await api['personas.list']({ query: { chatId: 'g1' } });
  assert.equal(scoped.body.effective, 'default', '会话有覆盖时 effective 要按覆盖算');
});

test('P5 list：chatId 是原型污染的名字 → 400', async () => {
  const { api } = build({ store: makeStore({ default: 'x' }), cfg: makeCfg({ mem: baseCfg() }) });
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await api['personas.list']({ query: { chatId: bad } })).status, 400);
  }
});

test('P6 read：缺 id 400，不存在 404，存在给 raw 与按码点算的字数', async () => {
  const store = makeStore({ default: '默认', cat: '喵😺' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  assert.equal((await api['personas.read']({ query: {} })).status, 400);
  const miss = await api['personas.read']({ query: { id: 'nope' } });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error, 'not_found');

  const hit = await api['personas.read']({ query: { id: 'cat' } });
  assert.equal(hit.body.raw, '喵😺');
  assert.equal(hit.body.chars, 2, 'emoji 只算一个字，不能用 .length（那会是 3）');
});

/* ── 3. personas.save：只改已存在的 ──────────────────────────────────── */

test('P7 save：不存在时 404 且**不新建**，并指向 create', async () => {
  const store = makeStore({ default: '默认' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.save']({ body: { id: 'cta', raw: '新正文' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
  assert.match(r.body.message, /personas\/create/);
  assert.equal(store.files.has('cta'), false, '拼错一个字母就多出一份空人格，这是最坏的静默行为');
});

test('P8 save：存在时整份替换，返回字数', async () => {
  const store = makeStore({ default: '旧' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.save']({ body: { id: 'default', raw: '新的' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.chars, 2);
  assert.equal(store.files.get('default'), '新的');
});

test('P9 save：缺 raw / raw 非字符串 / 超长 都拒', async () => {
  const store = makeStore({ default: '旧' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  assert.equal((await api['personas.save']({ body: { id: 'default' } })).status, 400);
  assert.equal((await api['personas.save']({ body: { id: 'default', raw: 1 } })).status, 400);
  const huge = await api['personas.save']({ body: { id: 'default', raw: 'x'.repeat(MAX_PERSONA_CHARS + 1) } });
  assert.equal(huge.status, 400);
  assert.match(huge.body.message, /太长/);
  assert.equal(store.files.get('default'), '旧', '被拒的写入不能落地');
});

test('P10 save：id 非法时把 store 的报错原样转出去，不吞成 500', async () => {
  const store = makeStore({ default: '旧' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });
  /** store.read 对 `a/b` 返回 null → 走 404 分支；这里直接造一个 read 命中的怪 id */
  store.read = (id) => ({ id, label: id, name: id, raw: 'x' });
  const r = await api['personas.save']({ body: { id: 'a/b', raw: 'y' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /路径分隔符/);
});

/* ── 4. personas.create ──────────────────────────────────────────────── */

test('P11 create：新建成功，frontmatter 从 label / selfName / tags 拼出来', async () => {
  const store = makeStore({ default: '默认' });
  const { api, logs } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.create']({
    body: { id: 'cat', raw: '我是猫', label: '猫娘', selfName: '小咪', tags: ['猫'] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  assert.equal(store.files.get('cat'), '---\nlabel: 猫娘\nselfName: 小咪\ntags: 猫\n---\n\n我是猫');
  assert.ok(logs.some((m) => m.includes('新建人格 cat')));
});

test('P12 create：不带 raw 也能建一份空人格（先占位再写）', async () => {
  const store = makeStore({ default: '默认' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });
  const r = await api['personas.create']({ body: { id: 'blank' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.chars, 0);
  assert.equal(store.files.get('blank'), '');
});

test('P13 create：已存在 → 409 且原文件不动；overwrite 才覆盖', async () => {
  const store = makeStore({ default: '旧内容' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const conflict = await api['personas.create']({ body: { id: 'default', raw: '新' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'conflict');
  assert.equal(store.files.get('default'), '旧内容', '没点头就不能覆盖');

  const over = await api['personas.create']({ body: { id: 'default', raw: '新', overwrite: true } });
  assert.equal(over.status, 200);
  assert.equal(over.body.overwritten, true);
  assert.equal(store.files.get('default'), '新');
});

test('P14 create：id 是原型污染的名字 / raw 非字符串 都拒', async () => {
  const store = makeStore({ default: 'x' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await api['personas.create']({ body: { id: bad } })).status, 400);
  }
  assert.equal((await api['personas.create']({ body: { id: 'ok', raw: {} } })).status, 400);
  assert.equal(store.files.has('ok'), false);
});

/* ── 5. personas.remove ──────────────────────────────────────────────── */

test('P15 remove：没有 confirm: true 一律不删', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const { api, removed } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.remove']({ body: { id: 'cat' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'need_confirm');
  assert.equal(store.files.has('cat'), true);
  assert.deepEqual(removed, []);
});

test('P16 remove：默认人格 / 不存在 都拒', async () => {
  const store = makeStore({ default: 'x' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });
  assert.equal((await api['personas.remove']({ body: { id: 'default', confirm: true } })).status, 400);
  assert.equal((await api['personas.remove']({ body: { id: 'nope', confirm: true } })).status, 404);
});

test('P17 remove：成功时级联清 byChat 引用', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const { api, removed } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.remove']({ body: { id: 'cat', confirm: true } });
  assert.equal(r.status, 200);
  assert.equal(store.files.has('cat'), false);
  assert.deepEqual(removed, ['cat'], '不清 byChat 的话那些群会一直指向不存在的人格');
});

test('P18 remove：备份失败（store 抛）→ 409，不假装删掉了', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  store.remove = () => { throw new Error('备份失败，已取消删除'); };
  const { api, removed } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });

  const r = await api['personas.remove']({ body: { id: 'cat', confirm: true } });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /备份失败/);
  assert.deepEqual(removed, []);
});

/* ── 6. session.configure ────────────────────────────────────────────── */

test('P19 configure：切全局 → persona.current，并回调 onSwitched（chatId 为空）', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api, switched } = build({ store, cfg });

  const r = await api['session.configure']({ body: { persona: 'cat' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.touched, ['persona']);
  assert.equal(cfg.state.mem.persona.current, 'cat');
  assert.deepEqual(switched, [{ id: 'cat', chatId: '', senderId: '', label: 'cat' }]);
});

test('P20 configure：切会话 → byChat[chatId]，不动 current', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api, switched } = build({ store, cfg });

  await api['session.configure']({ body: { persona: 'cat', chatId: 'g1' } });
  assert.equal(cfg.state.mem.persona.byChat.g1, 'cat');
  assert.equal(cfg.state.mem.persona.current, 'default');
  assert.equal(switched[0].chatId, 'g1');
});

test('P21 configure：chatId 传了但是空的 → 400，不能悄悄改全局', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { persona: 'cat', chatId: '' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /不能为空/);
  assert.equal(cfg.state.mem.persona.current, 'default', '前端拼错一个空键就把全局人格换了，用户看不出发生了什么');
});

test('P22 configure：人格不存在 / 什么都没给 都拒', async () => {
  const store = makeStore({ default: 'x' });
  const { api } = build({ store, cfg: makeCfg({ mem: baseCfg() }) });
  const miss = await api['session.configure']({ body: { persona: 'nope' } });
  assert.equal(miss.status, 404);
  assert.equal((await api['session.configure']({ body: {} })).status, 400);
});

test('P23 configure：基线取磁盘，内存里的旧快照不会把用户手改回滚', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  /** 内存是几小时前的快照（prompt = 旧），磁盘上用户已经手改成「新」 */
  const cfg = makeCfg({
    mem: { ...baseCfg(), speakUp: { prompt: '旧' } },
    disk: { ...baseCfg(), speakUp: { prompt: '新' } },
  });
  const { api } = build({ store, cfg });

  await api['session.configure']({ body: { persona: 'cat' } });
  assert.equal(cfg.state.mem.speakUp.prompt, '新', '整份写的基线必须是磁盘');
  assert.equal(cfg.state.mem.persona.current, 'cat');
});

test('P24 configure：clear 能删掉会话覆盖（深合并删不掉的东西）', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({
    mem: { ...baseCfg(), persona: { current: 'cat', byChat: { g1: 'cat', g2: 'default' }, name: 'n' } },
  });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { chatId: 'g1', clear: ['persona'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(cfg.state.mem.persona.byChat), ['g2']);
  assert.equal(r.body.persona.effective, 'cat', '清掉覆盖后回落到全局 cat');
});

test('P25 configure：clear persona（全局）回落 default；未知 clear 键静默忽略', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: { ...baseCfg(), persona: { current: 'cat', byChat: {}, name: 'n' } } });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { clear: ['persona', '不认识的'] } });
  assert.equal(r.status, 200);
  assert.equal(cfg.state.mem.persona.current, 'default');
  assert.deepEqual(r.body.touched, ['persona']);
});

test('P26 configure：model 归一后写入；全是未知键时当作清覆盖', async () => {
  const store = makeStore({ default: 'x' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });

  await api['session.configure']({ body: { chatId: 'g1', model: { provider: 'p', model: 'm', junk: 1 } } });
  assert.deepEqual(cfg.state.mem.model.byChat.g1, { provider: 'p', model: 'm' });

  await api['session.configure']({ body: { chatId: 'g1', model: { junk: 1 } } });
  assert.equal(cfg.state.mem.model.byChat.g1, undefined, '空壳模型该被删掉，而不是留个 {}');
});

test('P27 configure：chatId 是原型污染的名字 → 400，且没写进 byChat', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });

  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await api['session.configure']({ body: { persona: 'cat', chatId: bad } })).status, 400);
  }
  assert.deepEqual(Object.keys(cfg.state.mem.persona.byChat), []);
  assert.equal({}.current, undefined, 'Object.prototype 不能被污染');
});

test('P28 configure：onSwitched 抛错不影响切换结果', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api, logs } = build({
    store,
    cfg,
    onSwitched: () => { throw new Error('提示写不进去'); },
  });

  const r = await api['session.configure']({ body: { persona: 'cat' } });
  assert.equal(r.status, 200);
  assert.equal(cfg.state.mem.persona.current, 'cat');
  assert.ok(logs.some((m) => m.includes('切换提示没写上')));
});

test('P29 chatId 超长要报错，不能截短了指向另一个会话', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });
  const long = 'g'.repeat(MAX_CHAT_ID + 1);
  assert.equal((await api['session.configure']({ body: { persona: 'cat', chatId: long } })).status, 400);
  assert.equal((await api['personas.list']({ query: { chatId: long } })).status, 400);
  assert.deepEqual(Object.keys(cfg.state.mem.persona.byChat), []);
});

test('P30 构造时缺依赖要立刻炸，不要等到请求期', () => {
  assert.throws(() => createExtPersona({}), /personas/);
  assert.throws(() => createExtPersona({ personas: { save() {} } }), /cfgOf/);
});

/* ── 6b. 单人专属人设（senderId） ───────────────────────────────────── */

/**
 * 用户需求：「想给单人设置专属人设」。
 *
 * 原来的粒度只有 `byChat`（一个会话一个档），群里没法给某个人单独换。
 * 现在 `session.configure` 可以带 `senderId`（**发送者 openid**），
 * 写进 `persona.bySender`，优先级高于 `byChat`。
 *
 * 为什么必须和 `chatId` 分开：群里 `chatId` 是**群 openid**，拿它当「人」
 * 就是之前那类粒度错的翻版。
 */
test('P28 configure：给单个人指定人设 → bySender，不动 byChat / current', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { persona: 'cat', senderId: 'u1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.touched, ['persona']);
  assert.equal(cfg.state.mem.persona.bySender.u1, 'cat');
  assert.deepEqual(cfg.state.mem.persona.byChat, {}, '按人不能顺手写按会话');
  assert.equal(cfg.state.mem.persona.current, 'default', '也不动全局');
});

test('P29 configure：clear persona + senderId → 只删这个人那一格', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: { ...baseCfg(), persona: { current: 'default', byChat: { g1: 'cat' }, bySender: { u1: 'cat', u2: 'cat' } } } });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { clear: ['persona'], senderId: 'u1' } });
  assert.equal(r.status, 200);
  assert.equal(cfg.state.mem.persona.bySender.u1, undefined);
  assert.equal(cfg.state.mem.persona.bySender.u2, 'cat', '别人不受影响');
  assert.equal(cfg.state.mem.persona.byChat.g1, 'cat', '按会话那层也不受影响');
});

test('P30 configure：model 不能和 senderId 一起用（模型是按会话配的）', async () => {
  const store = makeStore({ default: 'x', cat: '猫' });
  const cfg = makeCfg({ mem: baseCfg() });
  const { api } = build({ store, cfg });

  const r = await api['session.configure']({ body: { model: { name: 'gpt' }, senderId: 'u1' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /按会话/);
  assert.equal(cfg.state.mem.model?.byChat?.u1, undefined, '一个字节都不该写');
});

test('P31 personas.list：带 senderId 时 effective 按人算（否则调用方以为没设上）', async () => {
  const store = makeStore({ default: 'x', cat: '猫', dog: '狗' });
  const cfg = makeCfg({
    mem: { ...baseCfg(), persona: { current: 'default', byChat: { g1: 'cat' }, bySender: { u1: 'dog' } } },
  });
  const { api } = build({ store, cfg });

  const asPerson = await api['personas.list']({ query: { senderId: 'u1' } });
  assert.equal(asPerson.body.effective, 'dog', '这个人的专属人格要盖过全局');
  assert.equal(asPerson.body.senderId, 'u1');

  const asChat = await api['personas.list']({ query: { chatId: 'g1' } });
  assert.equal(asChat.body.effective, 'cat');

  /** 同一个人在那个群里，仍然是他自己的那一套 */
  const both = await api['personas.list']({ query: { chatId: 'g1', senderId: 'u1' } });
  assert.equal(both.body.effective, 'dog');
});
