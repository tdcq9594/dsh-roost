/**
 * 扩展配置接口（`GET /v1/config` + `POST /v1/config`）
 *
 * 守的是三件事：
 *   1. **只做局部合并**：整份替换会让扩展一个手滑把几十项配置抹成默认值，
 *      而它根本不知道那些项存在；
 *   2. **危险项结构性拒绝**：端口 / 面板密钥 / 外接凭证 / 权限策略 / 安全开关 /
 *      扩展总闸 / 升级源 / 人格与模型，一律不许从配置口改 —— 不依赖主人有没有
 *      看懂风险提示；
 *   3. **「成功但没生效」要能看出来**：`saveConfig` 会把 `DEFAULTS` 之外的键
 *      静默裁掉，所以响应里回 `changed`，空数组就是「键名写错了」。
 *
 * 跑法：node --test test/ext-config-hooks.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExtConfigHooks, diffPaths, CONFIG_DENY, MAX_READ_KEYS,
} from '../src/ext-config-hooks.js';

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 深合并，语义对齐 `config.js` 的 `merge()`。
 */
function mergePlain(base, patch) {
  if (!isPlain(patch)) return patch;
  const out = { ...(isPlain(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) ? mergePlain(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * 照抄 `config.js` 的 `pruneTo()`：**递归**按 DEFAULTS 的形状裁剪，
 * 形状是空对象（`quota` / `byChat` 这类自由映射）时原样保留。
 *
 * 假宿主必须真做这一步，否则「键名拼错」的用例会假绿——真实环境里
 * `memory.injectCountt` 正是被这里裁掉的。
 */
function pruneToShape(shape, value) {
  if (Array.isArray(shape)) return Array.isArray(value) ? value : structuredClone(shape);
  if (isPlain(shape)) {
    if (!isPlain(value)) return structuredClone(shape);
    const keys = Object.keys(shape);
    if (!keys.length) return value;
    const out = {};
    for (const k of keys) out[k] = pruneToShape(shape[k], value[k]);
    return out;
  }
  return value === undefined ? shape : value;
}

/**
 * 假宿主：`readConfig` 给打码后的快照，`applyPatch` 模拟 `applyConfigBody`
 * 的两件关键行为——**按 DEFAULTS 裁剪**、返回新的 config。
 */
function makeHost(initial) {
  const shape = structuredClone(initial);
  const state = {
    config: structuredClone(initial),
    calls: [],
    status: 200,
  };
  return {
    state,
    readConfig: () => ({ config: structuredClone(state.config), revision: 'rev-1' }),
    applyPatch: (patch, opts) => {
      state.calls.push({ patch: structuredClone(patch), opts });
      if (state.status !== 200) {
        return { status: state.status, body: { ok: false, message: '模拟失败' } };
      }
      const next = structuredClone(state.config);
      for (const [k, v] of Object.entries(patch)) {
        if (k === '__revision') continue;
        /** 模拟 `saveConfig` 的 DEFAULTS 裁剪：形状里没有的键直接丢（递归） */
        if (!(k in shape)) continue;
        next[k] = pruneToShape(shape[k], mergePlain(next[k], v));
      }
      state.config = next;
      return { status: 200, body: { ok: true, config: structuredClone(next), revision: 'rev-2' } };
    },
  };
}

const initialCfg = () => ({
  server: { port: 17321, token: '' },
  memory: { injectCount: 12, enabled: true },
  chat: { typing: true },
  speakUp: { enabled: false, prompt: '原样' },
  security: { dangerousConfirm: true },
  tts: { apiKey: '******' },
});

function build(initial = initialCfg()) {
  const host = makeHost(initial);
  const logs = [];
  const api = createExtConfigHooks({
    readConfig: host.readConfig,
    applyPatch: host.applyPatch,
    log: (m) => logs.push(m),
  });
  return { api, host, logs };
}

/* ── 1. config.read ──────────────────────────────────────────────────── */

test('C1 read：不给 keys 就回整份 + revision', async () => {
  const { api } = build();
  const r = await api['config.read']({ query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.revision, 'rev-1');
  assert.equal(r.body.config.memory.injectCount, 12);
});

test('C2 read：给 keys 只回那几项，取不到的进 missing', async () => {
  const { api } = build();
  const r = await api['config.read']({ query: { keys: 'memory.injectCount, chat.typing ,nope.x' } });
  assert.deepEqual(r.body.values, { 'memory.injectCount': 12, 'chat.typing': true });
  assert.deepEqual(r.body.missing, ['nope.x']);
  assert.equal(r.body.config, undefined, '投影模式下不该再把整份塞回去');
});

test('C3 read：路径里有 __proto__ 之类一律当「没有」，不给探原型的口子', async () => {
  const { api } = build();
  const r = await api['config.read']({ query: { keys: '__proto__,constructor,memory.__proto__' } });
  assert.deepEqual(r.body.values, {});
  assert.deepEqual(r.body.missing, ['__proto__', 'constructor', 'memory.__proto__']);
});

test('C4 read：一次取太多要拒，别让人把配置页当爬虫', async () => {
  const { api } = build();
  const keys = Array.from({ length: MAX_READ_KEYS + 1 }, (_, i) => `k${i}`).join(',');
  const r = await api['config.read']({ query: { keys } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /最多取/);
});

/* ── 2. config.patch 的入参闸 ────────────────────────────────────────── */

test('C5 patch：缺 patch / patch 不是对象 / patch 为空 都拒，并给出形状', async () => {
  const { api, host } = build();
  const miss = await api['config.patch']({ body: {} });
  assert.equal(miss.status, 400);
  assert.match(miss.body.message, /"patch"/);

  assert.equal((await api['config.patch']({ body: { patch: [] } })).status, 400);
  assert.equal((await api['config.patch']({ body: { patch: {} } })).status, 400);
  assert.equal(host.state.calls.length, 0, '被拒的请求不该落到写配置那一层');
});

test('C6 patch：整份替换一律不给', async () => {
  const { api, host } = build();
  const r = await api['config.patch']({ body: { mode: 'full', patch: { memory: { injectCount: 1 } } } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /不能整份替换/);
  assert.equal(host.state.calls.length, 0);
});

test('C7 patch：CONFIG_DENY 里的顶层键全部 403，且一个都不写下去', async () => {
  const { api, host } = build();
  for (const key of Object.keys(CONFIG_DENY)) {
    const r = await api['config.patch']({ body: { patch: { [key]: { x: 1 } } } });
    assert.equal(r.status, 403, `${key} 应该被拒`);
    assert.equal(r.body.error, 'forbidden');
    assert.match(r.body.message, new RegExp(key));
  }
  assert.equal(host.state.calls.length, 0, '拒绝表是结构性收窄，不能先写再报错');
});

test('C8 patch：原型污染键（含嵌套）→ 400', async () => {
  const { api, host } = build();
  /** 必须走 JSON.parse：对象字面量里的 `__proto__:` 是设原型，不是建一个自有键 */
  const flat = await api['config.patch']({
    body: { patch: JSON.parse('{"__proto__":{"polluted":1}}') },
  });
  assert.equal(flat.status, 400);
  assert.match(flat.body.message, /不合法的键名/);

  const nested = await api['config.patch']({
    body: { patch: JSON.parse('{"memory":{"__proto__":{"x":1}}}') },
  });
  assert.equal(nested.status, 400);
  assert.equal(host.state.calls.length, 0);
  assert.equal({}.x, undefined, 'Object.prototype 不能被污染');
});

/* ── 3. config.patch 的正常路径 ──────────────────────────────────────── */

test('C9 patch：局部合并生效，changed 报真实变化的路径', async () => {
  const { api, host, logs } = build();
  const r = await api['config.patch']({ body: { patch: { memory: { injectCount: 8 } } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['memory.injectCount']);
  assert.equal(r.body.config, undefined, '200 不带整份配置，要看现状自己 GET 一次');
  assert.equal(host.state.config.memory.injectCount, 8);
  assert.equal(host.state.config.memory.enabled, true, '没提到的键不能被抹掉');
  assert.ok(logs.some((m) => m.includes('memory.injectCount')));
});

test('C10 patch：键名拼错（DEFAULTS 之外）→ ok 但 changed 为空并给出提示', async () => {
  const { api } = build();
  const r = await api['config.patch']({ body: { patch: { memory: { injectCountt: 8 } } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, []);
  assert.match(r.body.note, /没有变化/);
});

test('C11 patch：写配置失败（409 冲突）原样透传，不吞成 200', async () => {
  const { api, host } = build();
  host.state.status = 409;
  const r = await api['config.patch']({ body: { patch: { memory: { injectCount: 8 } } } });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
});

test('C12 patch：传了 revision 就透传成 __revision（乐观并发）', async () => {
  const { api, host } = build();
  await api['config.patch']({ body: { patch: { chat: { typing: false } }, revision: 'rev-1' } });
  assert.equal(host.state.calls[0].patch.__revision, 'rev-1');
  assert.equal(host.state.calls[0].opts.mode, 'patch');
  assert.equal(host.state.calls[0].opts.source, 'ext');

  await api['config.patch']({ body: { patch: { chat: { typing: true } } } });
  assert.equal('__revision' in host.state.calls[1].patch, false, '不传就不带');
});

test('C13 patch：密钥掩码原样提交回去不算变化', async () => {
  const { api } = build();
  const r = await api['config.patch']({ body: { patch: { tts: { apiKey: '******' } } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, [], '掩码回填后值没变，不该报成「改过密钥」');
});

/* ── 4. diffPaths 单元 ───────────────────────────────────────────────── */

test('C14 diffPaths：只报叶子路径，数组整体比', () => {
  const before = { a: { b: 1, c: [1, 2] }, d: 'x' };
  const after = { a: { b: 2, c: [1, 2] }, d: 'x' };
  assert.deepEqual(diffPaths(before, after), ['a.b']);

  assert.deepEqual(diffPaths({ a: [1, 2] }, { a: [1, 3] }), ['a'], '数组不该按下标展开刷屏');
  assert.deepEqual(diffPaths({ a: { b: 1 } }, { a: { b: 1, c: 2 } }), ['a.c'], '新增键也要报');
  assert.deepEqual(diffPaths({ a: { b: 1 } }, {}), ['a']);
});

test('C15 构造时缺依赖要立刻炸', () => {
  assert.throws(() => createExtConfigHooks({}), /readConfig/);
  assert.throws(() => createExtConfigHooks({ readConfig: () => ({}) }), /applyPatch/);
});
