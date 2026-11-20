/**
 * 阶段 5 / 门 G5：面板聚合层专项。
 *
 * 覆盖：清单与 usage 编辑、市场装扩展编辑后 sha256 失效、客户端令牌一次性显示、
 * 只认 ext.auth_failed 的状态判定、实际生效档位 fallback、五层拒绝诊断、
 * 三处 staged 联动互锁、以及 api-v1 / ext-memory 两处真实接线。
 *
 * 跑法：node --test test/ext-panel.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  createExtRegistry, createClientStore, SOURCE_FILE, MANIFEST_FILE,
} from '../src/ext-registry.js';
import { defaultStore } from '../src/capabilities.js';
import { USAGE_CHAR_LIMIT } from '../src/ext-usage.js';
import {
  createExtPanel, createRejectionLog, REJECTION_LAYERS, LOCALLY_MODIFIED_LABEL, SENSITIVE_SCOPES,
} from '../src/ext-panel.js';
import { createApiV1 } from '../src/api-v1.js';
import { createExtMemory } from '../src/ext-memory.js';

/** 统一在文件级 after 里清：夹具函数不必把 test context 一路传下来。 */
const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-panel-'));
  HOMES.push(d);
  return d;
}

function manifest(id, extra = {}) {
  return {
    id, serverName: id, name: `扩展${id}`, description: `这是 ${id} 的说明`,
    transport: 'stdio', command: 'node', args: ['server.mjs'],
    // §3.1：sha256 在**清单**里，`.source.json` 只是来源标记。夹具按真实结构造。
    sha256: 'b'.repeat(64), size: 128, publishedAt: '2026-11-10', ...extra,
  };
}

function stage(id, { source = null, extra = {} } = {}) {
  const d = tmpHome();
  // install() 用 basename(源目录) 当 expectedId，源目录必须就叫扩展 id。
  const src = join(d, id);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(join(src, MANIFEST_FILE), `${JSON.stringify(manifest(id, extra), null, 2)}\n`, 'utf8');
  const registry = createExtRegistry({ dir: d });
  const r = registry.install(src, { source });
  assert.equal(r.ok, true, r.reason);
  return { d, registry, src };
}

function fakeCapStore(over = {}) {
  const store = {
    ...defaultStore(),
    seen: { tools: { mcp__bili__feed: 1, mcp__bili__search: 1, qq_send: 1, memory_search: 1 }, skills: {}, lastScan: 1 },
    forceDeny: ['mcp__douyu__*'],
    ...over,
  };
  return { get: () => store, store };
}

function rig({ source = null, extra = {}, cfg = {}, capOver = {}, fallbackProbe = null } = {}) {
  const { d, registry, src } = stage('bili', { source, extra });
  const clientStore = createClientStore({ dir: d });
  const capStore = fakeCapStore(capOver);
  const rejections = createRejectionLog({ dir: d });
  const panel = createExtPanel({
    dir: d, registry, clientStore, capStore, rejections,
    cfg, fallbackProbe, log: { warn: () => {} },
  });
  return { d, registry, src, clientStore, capStore, rejections, panel };
}

/** 真实市场装来源标记里**没有** sha256（§8.3）。 */
const MARKET_SOURCE = () => ({ repo: 'market', tag: 'v1' });

// ---------------------------------------------------------------- 5.2 usage

test('G5-1 usageRows：预览、字节数、来源、校验和状态、总开关都在', () => {
  const r = rig({ source: MARKET_SOURCE() });
  const out = r.panel.usageRows();
  assert.equal(out.ok, true);
  assert.equal(out.enabled, false, '默认关：config.extensions.enabled 缺省 false');
  assert.equal(out.rows.length, 1);
  const one = out.rows[0];
  assert.equal(one.id, 'bili');
  assert.match(one.usage, /这是 bili 的说明/);
  assert.equal(one.bytes, Buffer.byteLength(one.usage, 'utf8'));
  assert.equal(one.chars, Array.from(one.usage).length);
  assert.equal(one.cap, USAGE_CHAR_LIMIT);
  assert.equal(one.foreign, false);
  assert.equal(one.sha256Valid, true);
  assert.equal(one.locallyModified, false);
  assert.equal(out.totalBytes, one.bytes);
});

test('G5-2 saveUsage 写回 plugin.json，且 liveUsage 下一条消息立即生效', () => {
  const r = rig({ source: MARKET_SOURCE() });
  const before = r.registry.liveUsage('bili');
  const saved = r.panel.saveUsage('bili', '自己写的说明');
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.usage, '自己写的说明');
  assert.notEqual(r.registry.liveUsage('bili'), before);
  assert.equal(r.registry.liveUsage('bili'), '自己写的说明');
  const disk = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'));
  assert.equal(disk.usage, '自己写的说明');
  assert.equal(disk.id, 'bili', '写回不能把清单其它字段冲掉');
  assert.equal(disk.transport, 'stdio');
});

test('G5-3 门 G5 核心：编辑市场装扩展使**清单** sha256 失效并标注', () => {
  const r = rig({ source: MARKET_SOURCE() });
  const saved = r.panel.saveUsage('bili', '改过的说明');
  assert.equal(saved.invalidated, true);
  assert.equal(saved.label, LOCALLY_MODIFIED_LABEL);
  const disk = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'));
  assert.equal(disk.sha256, null, '清单被改写后旧校验和必须置空');
  assert.equal(disk.locallyModified, true);
  assert.equal(disk.usage, '改过的说明');
  const src = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), SOURCE_FILE), 'utf8'));
  assert.equal(src.repo, 'market', '来源标记要原样保留');
  assert.equal(src.locallyModified, true);
  assert.ok(Number(src.modifiedAt) > 0);
  const row = r.panel.usageRows().rows[0];
  assert.equal(row.sha256Valid, false);
  assert.equal(row.locallyModified, true);
  assert.equal(row.label, LOCALLY_MODIFIED_LABEL);
});

test('G5-3b 市场装但清单原本没有 sha256，也要标注（不能靠 src.sha256 判）', () => {
  const r = rig({ source: MARKET_SOURCE(), extra: { sha256: undefined } });
  // fixture 里 undefined 会被 JSON.stringify 丢掉，等价于清单没有校验和字段。
  assert.equal(JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8')).sha256, undefined);
  const saved = r.panel.saveUsage('bili', '改了');
  assert.equal(saved.invalidated, true, '是否市场装只看 .source.json 在不在');
  const disk = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'));
  assert.equal(disk.sha256, null);
  assert.equal(disk.locallyModified, true);
});

test('G5-4 §8.3 foreign 只读：面板不许写回用户手写目录的清单', () => {
  const r = rig({ source: null });
  const row = r.panel.usageRows().rows[0];
  assert.equal(row.foreign, true);
  const before = fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8');
  const saved = r.panel.saveUsage('bili', '手写改的');
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'foreign_readonly');
  assert.equal(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'), before,
    '用户手写清单一字节都不能被面板改');
  assert.equal(fs.existsSync(join(r.registry.pathOf('bili'), SOURCE_FILE)), false);
});

test('G5-5 超 200 字按字符截断并 warn；坏 id / 缺清单明确失败', () => {
  const warns = [];
  const r = rig({ source: MARKET_SOURCE() });
  r.panel.saveUsage('bili', 'x'.repeat(30)); // 先确认基础写法
  const withLog = createExtPanel({
    dir: r.d, registry: r.registry, clientStore: r.clientStore,
    capStore: r.capStore, rejections: r.rejections,
    log: { warn: (m) => warns.push(m) },
  });
  const long = '汉'.repeat(USAGE_CHAR_LIMIT + 30);
  const saved = withLog.saveUsage('bili', long);
  assert.equal(saved.truncated, true);
  assert.equal(Array.from(saved.usage).length, USAGE_CHAR_LIMIT);
  assert.ok(warns.some((m) => m.includes('200 字')));
  assert.equal(withLog.saveUsage('../evil', 'x').reason, 'bad_id');
  assert.equal(withLog.saveUsage('nobody', 'x').reason, 'no_manifest');
});

// ---------------------------------------------------------------- 5.2 客户端

test('G5-6 客户端令牌：只存 hash、一次性显示、scope 白名单、不许自造 extId', () => {
  const r = rig({});
  const made = r.panel.createClient({
    name: '游戏裁判', scopes: ['agent:write', 'state:read'], confirm: true, principal: 'owner',
  });
  assert.equal(made.ok, true, made.message);
  assert.ok(made.token.length >= 30);
  const rec = r.clientStore.get(made.id);
  assert.equal(rec.hash, createHash('sha256').update(made.token).digest('hex'));
  assert.equal(rec.extId, undefined, '面板不能造出「属于某个扩展」的写入身份');
  assert.ok(!JSON.stringify(rec).includes(made.token), '明文绝不能落盘');
  const listed = r.panel.clients();
  assert.ok(listed.availableScopes.includes('agent:write'));
  const row = listed.rows.find((x) => x.id === made.id);
  assert.equal(row.kind, 'panel');
  assert.equal(row.hash, undefined, '面板列表不回 hash');
  assert.equal(r.panel.createClient({ scopes: ['not:a:scope'] }).reason, 'bad_scope');
});

test('G5-6b §7 最小授权：高权限 scope 要主人 + 二次确认，默认什么都不给', () => {
  const r = rig({});
  assert.equal(r.panel.createClient({ scopes: ['agent:write'], principal: 'owner' }).reason, 'needs_confirm');
  assert.equal(r.panel.createClient({ scopes: ['say:write'], confirm: true, principal: 'member' }).reason, 'not_owner');
  assert.deepEqual(r.panel.createClient({}).scopes, []);
  assert.ok(SENSITIVE_SCOPES.includes('agent:write'));
  assert.equal(r.clientStore.list().length, 1, '被拒的三次一次都不许写盘');
});

test('G5-7 revokeClient：面板客户端可吊销，扩展令牌只许由卸载管理', () => {
  const r = rig({});
  const made = r.panel.createClient({ scopes: [] });
  assert.equal(r.panel.revokeClient(made.id).ok, true);
  assert.equal(r.clientStore.get(made.id), null);
  r.clientStore.add({ id: 'ext:bili', hash: 'x'.repeat(64), extId: 'bili', scopes: [], enabled: true });
  assert.equal(r.panel.revokeClient('ext:bili').reason, 'ext_managed');
  assert.ok(r.clientStore.get('ext:bili'));
});

/**
 * 分页：装几十个扩展时，一个扩展一条 `ext:<id>` 令牌，整表一次拉下来没必要。
 *
 * 两个要点：`total` 是**过滤后**的总数（不是全库），以及新建的令牌必须
 * 出现在第一页——`clientStore.list()` 是追加顺序（新的在最后），不分页时
 * 无所谓，分页之后「刚发的令牌在最后一页」等于让人以为没发出去。
 */
test('G5-7b clients 分页：limit/offset 切片、total 是过滤后总数、新建的在第一页', () => {
  const r = rig({});
  /** 造 25 条，时间戳刻意全部相同：验证同毫秒下的排序稳定（按 id 兜底） */
  for (let i = 0; i < 25; i += 1) {
    r.clientStore.add({
      id: `ext:e${String(i).padStart(2, '0')}`, hash: 'h'.repeat(64), extId: `e${String(i).padStart(2, '0')}`,
      scopes: [], enabled: true, createdAt: 1000,
    });
  }
  const p1 = r.panel.clients();
  assert.equal(p1.rows.length, 20, '默认一页 20 条');
  assert.equal(p1.total, 25);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.offset, 0);
  assert.ok(p1.availableScopes.includes('agent:write'), 'availableScopes 每页都要给');

  const p2 = r.panel.clients({ offset: 20 });
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.hasMore, false);
  /** 两页不重叠、合起来正好是全量 */
  const ids = new Set([...p1.rows, ...p2.rows].map((x) => x.id));
  assert.equal(ids.size, 25);

  /** 新建的令牌（createdAt 更新）必须落在第一页第一条 */
  const made = r.panel.createClient({ name: '刚发的', scopes: [], principal: 'owner' });
  const after = r.panel.clients({ limit: 1 });
  assert.equal(after.total, 26);
  assert.equal(after.rows[0].id, made.id, '新建的令牌要在第一页，否则用户以为没发出去');
  assert.equal(after.hasMore, true);
});

test('G5-7c clients 分页：limit 夹紧、offset 容错、关键词只搜可见字段', () => {
  const r = rig({});
  for (let i = 0; i < 3; i += 1) {
    r.clientStore.add({
      id: `ext:k${i}`, hash: 'h'.repeat(64), extId: `k${i}`, name: `扩展 k${i}`,
      scopes: [], enabled: true, createdAt: 2000 + i,
    });
  }
  /** 上限 200：`limit=1e9` 不能把分页当摆设 */
  assert.equal(r.panel.clients({ limit: 1e9 }).rows.length, 3);
  /**
   * `limit=0` / 负数 / 非数字一律当「没给」，用默认 20。
   * 回 0 条对谁都没用，而回一整页至少能看出「参数传错了」。
   */
  assert.equal(r.panel.clients({ limit: 0 }).limit, 20, 'limit=0 回默认值，不是 0 条');
  assert.equal(r.panel.clients({ limit: -5 }).limit, 20);
  assert.equal(r.panel.clients({ limit: 'abc' }).limit, 20, '非法 limit 回默认值');
  assert.equal(r.panel.clients({ limit: 2 }).rows.length, 2);
  assert.equal(r.panel.clients({ offset: -3 }).offset, 0);
  assert.equal(r.panel.clients({ offset: 999 }).rows.length, 0);
  assert.equal(r.panel.clients({ offset: 999 }).hasMore, false);
  /** `Math.trunc(Infinity)` 还是 Infinity，会原样回给前端（HTTP 里变 null） */
  assert.equal(r.panel.clients({ offset: Infinity }).offset, 0);
  assert.equal(r.panel.clients({ offset: 'abc' }).offset, 0);
  assert.equal(r.panel.clients({ offset: 1.9 }).offset, 1);

  const q = r.panel.clients({ q: 'k1' });
  assert.equal(q.total, 1);
  assert.equal(q.rows[0].id, 'ext:k1');
  assert.equal(r.panel.clients({ q: '没这个' }).total, 0);
  /** 关键词不能搜到 hash —— 那是敏感字段，匹配到就等于泄露存在性 */
  assert.equal(r.panel.clients({ q: 'hhhh' }).total, 0);
});

// ---------------------------------------------------------------- 5.3 状态

test('G5-8 status 只认后端审计事件；waiting-credentials 不算鉴权失败', () => {
  const r = rig({});
  assert.equal(r.panel.status().authFailed, false);
  assert.equal(r.panel.status().regenerated, false);
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ op: 'v1.waiting-credentials', note: '官方等待态' }),
    JSON.stringify({ op: 'ext.auth_failed', note: 'GET /v1/whoami', at: 1 }),
    JSON.stringify({ op: 'ext.token_regenerated', note: 'bili', at: 2 }),
    'not-json',
  ].join('\n') + '\n', 'utf8');
  const s = r.panel.status();
  assert.equal(s.authFailed, true);
  assert.equal(s.regenerated, true);
  assert.equal(s.hintAuthFailed, '扩展鉴权失败');
  assert.equal(s.hintRegenerated, '令牌已重新生成');
  assert.equal(s.authFailedLast.note, 'GET /v1/whoami');
  assert.equal(s.regeneratedLast.note, 'bili');
});

/**
 * 自查补：状态是**当前态**，不是「曾经发生过」。
 *
 * 审计是只追加的日志。若一次 401 以后一直亮红灯，面板会永远喊「扩展鉴权失败」，
 * 而扩展其实早就恢复了 —— 永久假警报比不显示更坏。判据是「最后一条失败之后，
 * 有没有成功的 `/v1` 调用」。
 */
test('自查：失败之后成功调用过 → 当前态不再报鉴权失败；历史事实仍可查', () => {
  const r = rig({});
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 1000, op: 'ext.auth_failed', note: 'ext:bili' }),
    JSON.stringify({ at: 2000, op: 'v1.whoami', note: 'ok' }),
  ].join('\n') + '\n', 'utf8');
  const s = r.panel.status();
  assert.equal(s.authFailed, false, '失败后已经成功过，当前态应是正常');
  assert.equal(s.authFailedEver, true, '「曾经失败过」这个事实不能丢');
  assert.equal(s.lastOkAt, 2000);

  // 反过来：成功之后又失败 → 当前态是失败
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 1000, op: 'v1.whoami', note: 'ok' }),
    JSON.stringify({ at: 2000, op: 'ext.auth_failed', note: 'ext:bili' }),
  ].join('\n') + '\n', 'utf8');
  assert.equal(r.panel.status().authFailed, true, '最后一次是失败，当前态就该报');
});

test('G5-9 总开关用 getter 实时读，config 改完不用重建实例', () => {
  const cfg = { extensions: { enabled: false } };
  const r = rig({ cfg: () => cfg });
  assert.equal(r.panel.enabled(), false);
  assert.equal(r.panel.usageRows().enabled, false);
  cfg.extensions.enabled = true;
  assert.equal(r.panel.enabled(), true);
  assert.equal(r.panel.usageRows().enabled, true);
});

// ---------------------------------------------------------------- 5.1 档位与诊断

test('G5-10 实际生效档位：六档齐全、allow 可算 dry-run、fallback 由宿主探针判', () => {
  const r = rig({ fallbackProbe: () => ({ speakerKnown: false, effective: 'unknown', activeSessions: 0 }) });
  const out = r.panel.effectiveBuckets({ chatId: 'g1', speakerKnown: true });
  assert.equal(out.fallback.degraded, true, '前端自报 speakerKnown:true 不许覆盖宿主探针');
  assert.equal(out.buckets.length, 6);
  assert.deepEqual(out.buckets.map((b) => b.bucket), ['owner', 'admin', 'manager', 'helper', 'member', 'unknown']);
  assert.ok(out.buckets.every((b) => Array.isArray(b.allow) && b.allow.length > 0));
  assert.equal(out.fallback.degraded, true);
  assert.equal(out.fallback.effective, 'unknown');
  assert.match(out.fallback.reason, /没有活跃说话人/);
  assert.ok(Number.isFinite(out.fallback.allowCount), '兜底档也要用真实 resolvePolicy 算出允许数');
  assert.deepEqual(out.rules.forceDeny, ['mcp__douyu__*']);
});

test('G5-11 diagnose：五层顺序固定、每层规则与事件数可分辨', () => {
  const r = rig({});
  r.rejections.record({ layer: 'fence', tool: 'GET /v1/whoami', bucket: 'unknown', rule: '401' });
  r.rejections.record({ layer: 'guard', tool: 'qq_send', bucket: 'member', rule: '次数用完' });
  const out = r.panel.diagnose({ limit: 5 });
  assert.deepEqual(out.layers.map((L) => L.id), Object.keys(REJECTION_LAYERS));
  assert.equal(out.total, 2);
  const fence = out.layers.find((L) => L.id === 'fence');
  assert.equal(fence.events, 1);
  assert.equal(fence.last.rule, '401');
  assert.equal(fence.wired, true);
  const caps = out.layers.find((L) => L.id === 'capabilities');
  assert.equal(caps.wired, true, '能力层已在 host.js 的 planByCapabilities 里接上拒绝记录');
  assert.ok(out.layers.every((L) => Array.isArray(L.rules) && L.rules.length));
  assert.equal(out.recent.length, 2);
  assert.equal(out.recent[0].layer, 'guard', '最近一条排最前');
});

test('G5-12 rejectionLog：未知层拒绝、坏行跳过、超上限轮转', () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-rej-'));
  const log = createRejectionLog({ dir: d, max: 5 });
  assert.equal(log.record({ layer: 'made-up' }).reason, 'unknown_layer');
  for (let i = 0; i < 9; i++) log.record({ layer: 'quota', tool: `t${i}`, rule: 'r' });
  fs.appendFileSync(log.file, 'bad-line-not-json\n', 'utf8');
  assert.equal(log.rows().length, 5);
  assert.equal(log.rows()[0].tool, 't4');
  assert.equal(log.recent(2)[0].tool, 't8');
  assert.equal(log.summary().byLayer.quota.count, 5);
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ---------------------------------------------------------------- 五层接线实跑

function callV1(api, method, path, { token, body = {} } = {}) {
  const req = { method, url: `http://127.0.0.1${path}`, headers: {} };
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = { headersSent: false, writableEnded: false, headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  const send = (code, data) => { res.status = code; res.body = data; return res; };
  const url = new URL(req.url, 'http://127.0.0.1');
  return api.handle(req, res, url, { send, readJson: async () => ({ value: body }) }).then(() => res);
}

test('G5-13 接线：api-v1 的 401 / 403 落到 fence 层，且 401 写 ext.auth_failed', async () => {
  const r = rig({});
  const audits = [];
  const api = createApiV1({
    dir: r.d, clientStore: r.clientStore, auditFn: (e) => audits.push(e),
    onReject: (e) => r.rejections.record(e),
  });
  assert.equal((await callV1(api, 'GET', '/v1/whoami')).status, 401);
  assert.ok(audits.some((a) => a.op === 'ext.auth_failed'));
  r.clientStore.add({ id: 'ext:x', hash: createHash('sha256').update('tok').digest('hex'), extId: 'x', scopes: [], enabled: true });
  assert.equal((await callV1(api, 'GET', '/v1/agent.list', { token: 'tok' })).status, 403);
  const s = r.rejections.summary();
  assert.equal(s.byLayer.fence.count, 2);
  /**
   * 2026-11-14 放宽 `agent.*` 后：ext:x 的 scopes 是空的，拒绝理由从
   * 「扩展令牌被硬隔离」变成「缺少 scope：agent:write」。两种都要认，
   * 关键是 fence 层确实记下了这次拒绝。
   */
  assert.ok(/缺少 scope|EXT_ONLY_DENY|401/.test(s.byLayer.fence.last.rule));
});

test('G5-14 接线：ext-memory 的 ACL / quota 两层各自落到对应层', async () => {
  const r = rig({});
  const store = { add: async () => ({ ok: true, total: 1, deduped: false }), listAll: () => [], list: () => [] };
  const mem = createExtMemory({
    store, quota: { charge: () => ({ ok: false, message: '次数用完' }) },
    installedIds: () => ['bili'], onReject: (e) => r.rejections.record(e),
  });
  const acl = await mem.writeFromTool({ extId: 'bili', fact: 'x', caller: { bucket: 'unknown' } });
  assert.equal(acl.reason, 'acl');
  const q = await mem.writeFromTool({ extId: 'bili', fact: 'x', caller: { bucket: 'owner', kind: 'c2c' } });
  assert.equal(q.reason, 'quota');
  const s = r.rejections.summary();
  assert.equal(s.byLayer.acl.count, 1);
  assert.equal(s.byLayer.quota.count, 1);
});

// ---------------------------------------------------------------- 三处联动互锁

test('G7-7 8h 面板用例：兜底档常驻可见，且前端真的走 extensions.buckets', () => {
  const client = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.match(client, /extensions\.buckets/, '能力页要真的请求实际生效档位');
  assert.match(client, /档位兜底/, '兜底档必须常驻显示，不能只在退化时才出现');
  assert.match(client, /活跃会话/, '要能看到当前有没有活跃说话人（退化判据）');
  assert.ok(!client.includes('speakerKnown'), '前端不得自报 speakerKnown（退化由宿主探针判）');
});

test('G5-15 门 G5 三处联动：staged 清空、JSON_SECTIONS 补 extensions、白名单清空', async () => {
  const root = new URL('../', import.meta.url);
  const { FEATURES } = await import('../src/features.js');
  const client = fs.readFileSync(new URL('client/client.js', root), 'utf8');
  const routes = fs.readFileSync(new URL('test/routes.test.js', root), 'utf8');

  assert.equal(FEATURES.filter((f) => f.staged).length, 0, '① features.js 不该再有骨架开关');
  const block = client.slice(client.indexOf('const JSON_SECTIONS'), client.indexOf('function ConfigTab'));
  const keys = [...block.matchAll(/\['([a-zA-Z]+)',/g)].map((m) => m[1]);
  assert.ok(keys.includes('extensions'), '② 设置页 JSON_SECTIONS 必须列出 extensions');
  assert.equal(keys.filter((k) => k === 'extensions').length, 1, '不能重复列');
  assert.match(routes, /const NOT_SHIPPED = \[\]/, '③ routes.test.js 白名单必须清空');
  assert.ok(!/FEATURES\.find\(\(f\) => f\.id === 'extensions'\)\?\.staged, true/.test(routes),
    '③ 反查 staged:true 的 for 必须删掉');
  const { DEFAULTS } = await import('../src/config.js');
  assert.ok('extensions' in DEFAULTS, 'JSON_SECTIONS 的段必须在后端 DEFAULTS 里');
});

/**
 * 「哪个扩展在 401」要说得出。
 *
 * 用户反馈「鉴权一直不行」——而面板只有一句「检查令牌是否被吊销或凭据缺失」，
 * 最常见的真实原因却是「面板上把扩展停了、DSH 里的进程还在跑」，令牌本身是好的。
 * 所以审计 note 里要带 `disabled ext:<id>`，面板把它和停用清单一起摆出来。
 */
test('鉴权失败：能点名是谁（停用的扩展）+ 列出全部被停用的', () => {
  const r = rig({});
  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: false, scopes: [] });
  r.clientStore.add({ id: 'ext:imagegen', name: '扩展 imagegen', hash: 'y', extId: 'imagegen', enabled: false, scopes: [] });
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 10, op: 'ext.auth_failed', note: 'GET /v1/state | disabled ext:bili' }),
  ].join('\n') + '\n', 'utf8');

  const s = r.panel.status();
  assert.equal(s.authFailed, true);
  assert.equal(s.authFailedWho, 'disabled ext:bili');
  assert.deepEqual(s.disabledClients.sort(), ['bili', 'imagegen']);
});

test('鉴权失败：令牌完全对不上时如实说 unknown-token，不瞎点名', () => {
  const r = rig({});
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 10, op: 'ext.auth_failed', note: 'POST /v1/say | unknown-token' }),
  ].join('\n') + '\n', 'utf8');
  const s = r.panel.status();
  assert.equal(s.authFailedWho, 'unknown-token');
  assert.deepEqual(s.disabledClients, []);
});

/**
 * 「灯灭了、扩展还在 401」——用户原话：「重新点进来又可以了，但鉴权一直不行」。
 *
 * 原来「已恢复」的判据是「最后一条失败之后有没有任何一次成功的 `/v1` 调用」，
 * 而成功记录不带客户端 id —— 一个健康的扩展就能把另一个坏掉的扩展的红灯熄掉。
 * 能点名的失败（`disabled ext:<id>`）改成按人判：那个扩展还在停用名单里就亮着。
 */
test('鉴权失败：别的扩展调通了，不能把停用那个的红灯熄掉', () => {
  const r = rig({});
  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: false, scopes: [] });
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 10, op: 'ext.auth_failed', note: 'GET /v1/state | disabled ext:bili' }),
    /** 另一个扩展（imagegen）调通了 —— 它不该让 bili 的红灯灭掉 */
    JSON.stringify({ at: 20, op: 'v1.state', note: 'ok' }),
  ].join('\n') + '\n', 'utf8');

  const s = r.panel.status();
  assert.equal(s.lastOkAt, 20);
  assert.equal(s.authFailed, true, 'bili 还停着，红灯不能因为别人成功就熄');

  /** 重新启用之后，才回到「看有没有成功调用」的常规判据 */
  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: true, scopes: [] });
  assert.equal(r.panel.status().authFailed, false, '重新启用后不再按「还在停用」算');
});

/**
 * 能点名的红灯，「为什么亮 / 什么时候灭」要说清楚：
 *
 *   · 扩展还被停用            → 亮（提醒「进程可能还在跑，重启 DSH」）
 *   · 重新启用但还没调通       → **仍然亮**：进程还是旧令牌，401 还在发生。
 *                               提前熄灯就是回到「灯灭了、扩展照样 401」那个旧毛病。
 *   · 真的调通一次            → 灭（这条在原有用例里已覆盖）
 *   · 卸载了（目录+记录都没了）→ 灭：对象已经不存在，不能指着一个历史审计常亮
 *
 * 最后一条是这次修的：旧判据比时间，卸载后不会再有成功调用，
 * `lastFail.at > lastOkAt` 恒成立，红灯怎么点都消不掉。
 */
test('鉴权失败：重新启用但还没调通，红灯必须继续亮（不能提前熄灯）', () => {
  const r = rig({});
  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: false, scopes: [] });
  /** 只有失败、一次成功都没有：lastOkAt 是 0 */
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 10, op: 'ext.auth_failed', note: 'GET /v1/state | disabled ext:bili' }),
  ].join('\n') + '\n', 'utf8');
  assert.equal(r.panel.status().authFailed, true);

  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: true, scopes: [] });
  const s = r.panel.status();
  assert.equal(s.authFailedWho, 'disabled ext:bili');
  assert.equal(s.authFailed, true, '进程还在用旧令牌 401，灯不能先灭 —— 那正是要提醒重启 DSH 的时候');
});

test('鉴权失败：卸载之后红灯要灭（旧审计记录不代表现状）', () => {
  /** 走市场装的，才允许直接卸载（用户手写目录要 force） */
  const r = rig({ source: MARKET_SOURCE() });
  r.clientStore.add({ id: 'ext:bili', name: '扩展 bili', hash: 'x', extId: 'bili', enabled: false, scopes: [] });
  fs.writeFileSync(join(r.d, 'audit.log'), [
    JSON.stringify({ at: 10, op: 'ext.auth_failed', note: 'GET /v1/state | disabled ext:bili' }),
  ].join('\n') + '\n', 'utf8');
  assert.equal(r.panel.status().authFailed, true);

  /** 真实卸载路径：删目录 + 删客户端记录 */
  assert.equal(r.registry.remove('bili').ok, true);
  assert.equal(r.clientStore.revoke('ext:bili'), true);

  const s = r.panel.status();
  assert.equal(s.authFailed, false, '这个扩展已经不存在了，红灯没有可指向的对象');
  assert.equal(s.authFailedEver, true, '「曾经失败过」这个历史事实仍要留着');
});

test('鉴权失败：api-v1 写进审计的点名，面板要能原样认出来（跨模块契约）', async () => {
  const r = rig({});
  const audits = [];
  const api = createApiV1({
    dir: r.d, clientStore: r.clientStore,
    auditFn: (e) => audits.push(e),
    onReject: () => {},
  });
  /** `EXT_ID_RE` 上限 32 字符，加上 `disabled ext:` 前缀共 45 —— note 里最长的那段 */
  const id = 'a'.repeat(32);
  const token = 'tok-long-id';
  r.clientStore.add({
    id: `ext:${id}`, name: `扩展 ${id}`,
    hash: createHash('sha256').update(token).digest('hex'),
    extId: id, scopes: [], enabled: false,
  });
  /** 最长端点之一：端点名字变长时，长度上限最容易在这里先把 who 吃掉 */
  const res = await callV1(api, 'POST', '/v1/memory/facts/edit', { token });
  assert.equal(res.status, 401);

  const note = String(audits.find((a) => a.op === 'ext.auth_failed')?.note ?? '');
  assert.ok(note.includes(`disabled ext:${id}`), `审计里的点名必须完整，实际是：${note}`);

  /** 同一条审计喂给面板：who 要能被解析出来，并且对上停用名单 */
  fs.writeFileSync(join(r.d, 'audit.log'), `${JSON.stringify({ at: 10, op: 'ext.auth_failed', note })}\n`, 'utf8');
  const s = r.panel.status();
  assert.equal(s.authFailedWho, `disabled ext:${id}`);
  assert.ok(s.disabledClients.includes(id));
  assert.equal(s.authFailed, true);
});
