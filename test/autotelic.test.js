// 自驱引擎：账本链要能验、闸门要能拦、失败要能卡住、默认必须关着。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stableStringify, makeEntry, hashOf, verifyChain, readLedger, appendLedger,
  dayStats, ledgerPath, GENESIS, KINDS,
} from '../src/autotelic-ledger.js';
import {
  normalizeCfg, inQuietHours, scoreCuriosity, pickProject, buildStepPrompt,
  createAutotelic, AUTOTELIC_DEFAULTS, STATE_FILE, describeCapability, sessionIdFor, constraintLines,
} from '../src/autotelic.js';

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ } };
const tmp = () => mkdtempSync(join(tmpdir(), 'roost-auto-'));

/* ---------------- 账本 ---------------- */

test('稳定序列化：键序不同得到同一个哈希', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }), '数组顺序是语义，不能排');
});

test('账本：追加三条，链能验过，prev 首尾相接', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    for (const kind of ['boot', 'project', 'step']) {
      const r = appendLedger(f, { kind, payload: { x: 1 }, note: kind });
      assert.equal(r.ok, true, r.reason);
    }
    const { rows, total } = readLedger(f);
    assert.equal(total, 3);
    assert.equal(rows[0].prev, GENESIS);
    assert.equal(rows[1].prev, rows[0].hash);
    assert.equal(rows[2].seq, 3);
    assert.deepEqual(verifyChain(rows), { ok: true, total: 3, brokenAt: 0, reason: '' });
  } finally { cleanup(dir); }
});

test('账本：改一条内容 → 断在它自己；删中间一条 → 断在后面', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    for (let i = 0; i < 4; i++) appendLedger(f, { kind: 'step', note: `n${i}`, payload: { i } });
    const { rows } = readLedger(f);

    const tampered = rows.map((r, i) => (i === 1 ? { ...r, note: '被改了' } : r));
    const a = verifyChain(tampered);
    assert.equal(a.ok, false);
    assert.equal(a.brokenAt, 2, '断点应该指向被改的那一条（序号从 1 起）');

    const removed = [rows[0], rows[2], rows[3]];
    const b = verifyChain(removed);
    assert.equal(b.ok, false);
    assert.equal(b.brokenAt, 2, '删掉中间一条，第二条的序号就接不上了');
  } finally { cleanup(dir); }
});

test('账本：尾部坏了就不再往上接（不造一条永远验不过的链）', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    appendLedger(f, { kind: 'step', note: 'ok' });
    /** 手工把最后一行改坏 */
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    const bad = JSON.parse(lines[0]);
    bad.note = '手改的';
    writeFileSync(f, `${JSON.stringify(bad)}\n`, 'utf8');

    const r = appendLedger(f, { kind: 'step', note: 'next' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /账本已损坏/);
  } finally { cleanup(dir); }
});

test('账本：坏行跳过并计数，不整本读不出来', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    appendLedger(f, { kind: 'step', note: 'good' });
    writeFileSync(f, `${readFileSync(f, 'utf8')}{这不是 JSON\n`, 'utf8');
    const r = readLedger(f);
    assert.equal(r.rows.length, 1);
    assert.equal(r.badLines, 1);
  } finally { cleanup(dir); }
});

test('账本：kind 只认闭集，乱填当 step；note 有长度上限', () => {
  const e = makeEntry({ kind: '乱写的', note: 'x'.repeat(5000) });
  assert.equal(e.kind, 'step');
  assert.equal(e.note.length, 2000);
  assert.deepEqual(KINDS.includes(e.kind), true);
});

test('按天统计：只算当天，分类计数', () => {
  const day = '2026-11-14';
  const at = new Date(`${day}T10:00:00Z`).getTime();
  const rows = [
    { seq: 1, at, kind: 'project' },
    { seq: 2, at: at + 1000, kind: 'step' },
    { seq: 3, at: at + 2000, kind: 'deny' },
    { seq: 4, at: at - 86400000, kind: 'step' },
  ];
  const s = dayStats(rows, day);
  assert.equal(s.total, 3);
  assert.equal(s.steps, 1);
  assert.equal(s.denies, 1);
  assert.equal(s.projects, 1);
});

/* ---------------- 配置与闸门 ---------------- */

test('配置：默认全关，写坏了夹回合法范围', () => {
  const d = normalizeCfg({});
  assert.equal(d.enabled, false);
  assert.equal(d.allowAct, false);
  assert.equal(d.heartbeatMin, 0, '默认不自动心跳');

  const wild = normalizeCfg({ maxPerDay: 999, failLimit: 0, stuckHours: -5, heartbeatMin: -1, seeds: ['  a  ', '', 42] });
  assert.equal(wild.maxPerDay, 24);
  assert.equal(wild.failLimit, 1);
  assert.equal(wild.stuckHours, 1);
  assert.equal(wild.heartbeatMin, 0);
  assert.deepEqual(wild.seeds, ['a', '42']);
});

test('安静时段：起止相同 = 关闭，跨零点也要对', () => {
  assert.equal(inQuietHours({ quietStartHour: 0, quietEndHour: 0 }, 3), false);
  const night = { quietStartHour: 22, quietEndHour: 7 };
  assert.equal(inQuietHours(night, 23), true);
  assert.equal(inQuietHours(night, 3), true);
  assert.equal(inQuietHours(night, 12), false);
  assert.equal(inQuietHours(night, 7), false, '右端不含');
});

test('好奇分：越久没碰越高，做过的降权，范围夹在 0–1', () => {
  const fresh = scoreCuriosity({ ageDays: 0 });
  const old = scoreCuriosity({ ageDays: 30 });
  assert.ok(old > fresh, '搁得久的更想');
  assert.ok(scoreCuriosity({ ageDays: 30, doneCount: 3 }) < old, '做过的降权');
  for (const v of [fresh, old, scoreCuriosity({ ageDays: 999, deferred: 99 })]) {
    assert.ok(v >= 0 && v <= 1, `分数越界：${v}`);
  }
});

test('立项：没有种子就明说，做满 3 次的被否掉并给理由', () => {
  assert.equal(pickProject([]).ok, false);
  assert.match(pickProject([]).reason, /种子/);

  const history = [
    { kind: 'step', at: Date.now(), payload: { project: 'A' } },
    { kind: 'step', at: Date.now(), payload: { project: 'A' } },
    { kind: 'step', at: Date.now(), payload: { project: 'A' } },
  ];
  const r = pickProject([{ text: 'A' }, { text: 'B' }], { history });
  assert.equal(r.ok, true);
  assert.equal(r.project.text, 'B');
  assert.equal(r.rejected[0].text, 'A');
  assert.match(r.rejected[0].reason, /3 次/);
});

test('推进 prompt：不允许动手时明确禁止，允许时也禁止发 QQ 消息', () => {
  const no = buildStepPrompt({ project: '想想怎么把话说明白', allowAct: false });
  assert.match(no, /只能想，不能动手/);

  const yes = buildStepPrompt({ project: 'x', allowAct: true });
  assert.match(yes, /不要发任何 QQ 消息/);
  assert.doesNotMatch(yes, /只能想，不能动手/);
});

/* ---------------- 引擎 ---------------- */

test('引擎：默认关着时一律拒绝，并且把拒绝也记进账本', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({ dir, cfgOf: () => ({ seeds: ['想想天气'] }) });
    assert.equal(e.status().enabled, false);
    const r = e.think({ manual: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /没开/);

    /** 拒绝必须留痕：不然「为什么她什么都不做」查不出来 */
    const { rows } = readLedger(ledgerPath(dir));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'deny');
    assert.match(rows[0].note, /没开/);
  } finally { cleanup(dir); }
});

test('引擎：开了但没种子 → 拒绝，理由具体', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({ dir, cfgOf: () => ({ enabled: true, seeds: [] }) });
    const r = e.think();
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有种子/);
  } finally { cleanup(dir); }
});

test('引擎：立项只记账不跑模型，状态写盘能跨重启', () => {
  const dir = tmp();
  try {
    let calls = 0;
    const cfgOf = () => ({ enabled: true, seeds: ['想想怎么回消息更自然'] });
    const e = createAutotelic({ dir, cfgOf, run: async () => { calls += 1; return 'x'; } });
    const r = e.think({ manual: true });
    assert.equal(r.ok, true);
    assert.equal(calls, 0, '立项不该跑模型');
    assert.ok(existsSync(join(dir, STATE_FILE)));

    /** 新实例读回同一个项目 */
    const e2 = createAutotelic({ dir, cfgOf });
    assert.equal(e2.status().project.text, '想想怎么回消息更自然');
    assert.equal(e2.status().ledger.chain.ok, true);
  } finally { cleanup(dir); }
});

test('引擎：推进成功记一条 step，失败计数并在到上限时卡住', async () => {
  const dir = tmp();
  try {
    let fail = false;
    const cfgOf = () => ({ enabled: true, seeds: ['A'], failLimit: 2, maxPerDay: 5 });
    const e = createAutotelic({
      dir, cfgOf,
      run: async () => { if (fail) throw new Error('模型挂了'); return '想到一点了'; },
    });
    e.think();

    const ok = await e.step();
    assert.equal(ok.ok, true);
    assert.equal(ok.text, '想到一点了');
    assert.equal(e.status().failures, 0);

    fail = true;
    const a = await e.step();
    assert.equal(a.ok, false);
    assert.equal(e.status().failures, 1);
    assert.equal(e.status().stuck, false, '一次失败还没到上限');

    const b = await e.step();
    assert.equal(b.ok, false);
    assert.match(b.reason, /连续失败 2 次/);
    assert.equal(e.status().stuck, true);

    /** 卡住期间直接拒绝，且不再跑模型 */
    let ran = 0;
    const e2 = createAutotelic({ dir, cfgOf, run: async () => { ran += 1; return 'x'; } });
    const c = await e2.step();
    assert.equal(c.ok, false);
    assert.match(c.reason, /卡住/);
    assert.equal(ran, 0);

    /** 失败也要进账本，而且最后一条是 stuck */
    const { rows } = readLedger(ledgerPath(dir));
    assert.ok(rows.some((r) => r.kind === 'step' && r.payload?.failed), '失败的那一轮要留痕');
    /** 最后一条是 e2 被卡住时记的 deny，stuck 在它前面 */
    assert.ok(rows.some((r) => r.kind === 'stuck'), '达到上限要记一条 stuck');
    assert.equal(rows[rows.length - 1].kind, 'deny', '卡住期间再触发要留一条拒绝');
  } finally { cleanup(dir); }
});

test('引擎：一天推进次数到上限就拦', async () => {
  const dir = tmp();
  try {
    const cfgOf = () => ({ enabled: true, seeds: ['A'], maxPerDay: 1 });
    const e = createAutotelic({ dir, cfgOf, run: async () => 'ok' });
    e.think();
    assert.equal((await e.step()).ok, true);
    const second = await e.step();
    assert.equal(second.ok, false);
    assert.match(second.reason, /上限 1/);
  } finally { cleanup(dir); }
});

test('引擎：heartbeatMin=0 时 tick 什么都不做（默认不会自己跑）', async () => {
  const dir = tmp();
  try {
    let ran = 0;
    const e = createAutotelic({
      dir, cfgOf: () => ({ enabled: true, seeds: ['A'] }), run: async () => { ran += 1; return 'x'; },
    });
    const r = await e.tick();
    assert.equal(r.ok, false);
    assert.match(r.reason, /没开自动心跳/);
    assert.equal(ran, 0);
  } finally { cleanup(dir); }
});

test('引擎：没接 run 时 step 给明确原因，不是崩', async () => {
  const dir = tmp();
  try {
    const e = createAutotelic({ dir, cfgOf: () => ({ enabled: true, seeds: ['A'] }) });
    const r = await e.step();
    assert.equal(r.ok, false);
    assert.match(r.reason, /没接上会话/);
  } finally { cleanup(dir); }
});

test('引擎：复盘把当天账本收成人话，并且自己也记一条', () => {
  const dir = tmp();
  try {
    const cfgOf = () => ({ enabled: true, seeds: ['A'] });
    const e = createAutotelic({ dir, cfgOf });
    e.think({ manual: true });

    const r = e.review();
    assert.equal(r.ok, true);
    assert.match(r.text, /立项 1 次/);
    assert.match(r.text, /今天想的是：A/);

    const { rows } = readLedger(ledgerPath(dir));
    assert.equal(rows[rows.length - 1].kind, 'review');
  } finally { cleanup(dir); }
});

test('引擎：预览列出候选与被否决项，不写账本', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({ dir, cfgOf: () => ({ enabled: true, seeds: ['A', 'B'] }) });
    const p = e.preview();
    assert.equal(p.ok, true);
    assert.ok(['A', 'B'].includes(p.project.text));
    assert.deepEqual(readLedger(ledgerPath(dir)).rows, [], '预览不该写账');
  } finally { cleanup(dir); }
});

/* ---------------- 能力状态条（阶段 0） ---------------- */

test('能力状态条：四种状态都说实话，allowAct 不谎称授权闸门', () => {
  const off = describeCapability({ enabled: false, allowAct: false, canRun: { ok: false, reason: '自驱引擎没开（默认关）' } });
  assert.equal(off.ok, false);
  assert.match(off.headline, /总开关关着/);
  assert.match(off.tool, /禁止用工具/);
  assert.match(off.note, /不是授权闸门/);

  const blocked = describeCapability({ enabled: true, canRun: { ok: false, reason: '现在是安静时段' } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.headline, '现在是安静时段', '被拦原因要原样显示，别吞掉');

  const ready = describeCapability({ enabled: true, canRun: { ok: true } });
  assert.equal(ready.ok, true);
  assert.match(ready.headline, /可以立项/);

  const acting = describeCapability({ enabled: true, allowAct: true, canRun: { ok: true } });
  assert.match(acting.tool, /prompt 允许用工具/);
  assert.match(acting.tool, /全局守卫/, '开了 allowAct 也要说清危险命令仍被全局守卫拦');
  assert.equal(acting.lines.length, 3, '三条：能不能跑 / 工具措辞 / 闸门真相');
});

test('能力状态条：status() 带出 capability，与 canRun 一致', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({ dir, cfgOf: () => ({ enabled: true, allowAct: false, seeds: ['A'] }) });
    const s = e.status();
    assert.ok(s.capability, 'status 必须带 capability 供面板渲染');
    assert.equal(s.capability.ok, s.canRun.ok);
    /** canRun.ok=true 时没有 reason：headline 就走「可以立项」；否则原样带出拦截原因 */
    if (s.canRun.ok === false) assert.equal(s.capability.headline, s.canRun.reason);
    else assert.match(s.capability.headline, /可以立项/);
  } finally { cleanup(dir); }
});

/* ---------------- 账本新字段：向后兼容（阶段 1） ---------------- */

test('账本：新增五类 kind，五类可选字段都能记且验链过', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    for (const kind of ['dream', 'ticket', 'evidence', 'skill', 'verdict']) {
      assert.equal(KINDS.includes(kind), true, `${kind} 必须进闭集，否则会被悄悄改成 step`);
    }
    const e = makeEntry({
      kind: 'ticket', payload: { intent: '试一件事' }, note: '带全字段',
      sessionId: 'autotelic-abc', tag: '学习', verdict: 'pass', source: 'preview',
      evidence: [{ id: 'w-1', text: '主人说过想学', source: 'owner' }],
    });
    assert.equal(e.kind, 'ticket');
    assert.equal(e.sessionId, 'autotelic-abc');
    assert.equal(e.evidence[0].id, 'w-1');
    assert.equal(verifyChain([e]).ok, true, '带新字段的记录自己要验得过');

    const r = appendLedger(f, {
      kind: 'evidence', note: '证据入账', sessionId: 's-1', verdict: 'reject',
      evidence: [{ id: 'x', text: '无出处', source: '' }],
    });
    assert.equal(r.ok, true);
    const rows = readLedger(f, { limit: 0 }).rows;
    assert.equal(rows[0].verdict, 'reject');
    assert.equal(verifyChain(rows).ok, true, '新字段落盘后验链要过');

    const tampered = [{ ...rows[0], verdict: 'pass' }];
    assert.equal(verifyChain(tampered).ok, false, '改 verdict 必须断链，否则字段只是装饰');
  } finally { cleanup(dir); }
});

test('账本：旧账本没有新字段，升级后验链仍过（兼容）', () => {
  const dir = tmp();
  try {
    const f = ledgerPath(dir);
    /** 模拟升级前的记录：只有 seq / at / kind / note / payload / prev / hash */
    const old = makeEntry({ seq: 1, kind: 'project', payload: { project: 'A' }, note: '老记录' });
    assert.equal('sessionId' in old, false);
    writeFileSync(f, `${JSON.stringify(old)}\n`, 'utf8');
    assert.equal(verifyChain(readLedger(f, { limit: 0 }).rows).ok, true);
    /** 往老账本后面追加带新字段的记录，链要接得上 */
    const r = appendLedger(f, { kind: 'dream', note: '梦种子', sessionId: 's-2' });
    assert.equal(r.ok, true);
    assert.equal(verifyChain(readLedger(f, { limit: 0 }).rows).ok, true);
  } finally { cleanup(dir); }
});

/* ---------------- 会话隔离 / 约束前置（阶段 1） ---------------- */

test('会话隔离：项目 id 派生 sessionId，老项目回落固定会话', () => {
  assert.equal(sessionIdFor('p-abc'), 'autotelic-p-abc');
  assert.notEqual(sessionIdFor('p-1'), sessionIdFor('p-2'), '两个项目不能共用会话');
  assert.equal(sessionIdFor(''), 'autotelic-main', '老项目/无 id 回落，避免断片');
});

test('step 把派生的 sessionId 传给 run，并把 sid / verdict 记进账本', async () => {
  const dir = tmp();
  try {
    const seen = [];
    const e = createAutotelic({
      dir,
      cfgOf: () => ({ enabled: true, seeds: ['琢磨一件事'], allowAct: false }),
      run: async (prompt, opts) => { seen.push(opts?.sessionId); return '想到一点东西'; },
    });
    const r = await e.step({ manual: true });
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^autotelic-p-/, '必须按项目派生，不再是写死的 autotelic-main');
    const rows = readLedger(ledgerPath(dir), { limit: 0 }).rows;
    assert.ok(rows.some((x) => x.kind === 'step' && x.sessionId === seen[0] && x.verdict === 'pass'));
    assert.ok(rows.some((x) => x.kind === 'manual' && x.evidence?.[0]?.source === 'seed'));
  } finally { cleanup(dir); }
});

test('约束前置：constraintLines 逐行拆、去空、限长，不做模型自判', () => {
  assert.deepEqual(constraintLines('不许半夜发消息\n\n 不许花钱 \n'), ['不许半夜发消息', '不许花钱']);
  assert.deepEqual(constraintLines(123), ['123'], '非字符串按文本容错，不静默吞掉');
  assert.equal(constraintLines('x\n'.repeat(100)).length, 50);
  const s = createAutotelic({ dir: tmp(), cfgOf: () => ({ constraintRules: '不许半夜发消息' }) }).status();
  assert.deepEqual(s.constraints, ['不许半夜发消息']);
});

test('配置默认值两处一致：config.DEFAULTS 与 autotelic.AUTOTELIC_DEFAULTS 不能漂移', async () => {
  const { DEFAULTS } = await import('../src/config.js');
  const D = DEFAULTS.autotelic;
  const A = AUTOTELIC_DEFAULTS;
  const keys = Object.keys(A);
  assert.deepEqual(Object.keys(D).sort(), keys.sort(), '两处键集必须完全相同，否则 normalizeCfg 会取到 undefined');
  for (const k of keys) assert.deepEqual(D[k], A[k], `${k} 两处默认值不一致`);
  assert.equal(DEFAULTS.speakUp.followUps, 1, 'followUps 必须在 DEFAULTS，否则面板存盘被裁');
});

test('约束真注入 prompt：不再只展示不生效（阶段3 B2）', () => {
  const p = buildStepPrompt({ project: '琢磨一件事', constraints: ['不许半夜发消息', '不许碰主人配置'] });
  assert.match(p, /主人定下的硬规矩/);
  assert.match(p, /不许半夜发消息/);
  assert.match(p, /不许碰主人配置/);
  const empty = buildStepPrompt({ project: '琢磨一件事' });
  assert.doesNotMatch(empty, /硬规矩/, '没约束时不该出现空段');
});

test('step 把配置的约束传进 prompt（端到端，不是只测函数）', async () => {
  const dir = tmp();
  try {
    let seenPrompt = '';
    const e = createAutotelic({
      dir,
      cfgOf: () => ({ enabled: true, seeds: ['琢磨一件事'], constraintRules: '不许半夜发消息' }),
      run: async (prompt) => { seenPrompt = prompt; return 'ok'; },
    });
    await e.step({ manual: true });
    assert.match(seenPrompt, /不许半夜发消息/, '主人写的约束必须真到达模型');
  } finally { cleanup(dir); }
});

test('约束硬否决：触犯规则的项目不立项，记 deny 账（阶段4）', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({
      dir,
      cfgOf: () => ({
        enabled: true, seeds: ['半夜给主人发消息'],
        constraintRules: '不要半夜说话',
      }),
    });
    const r = e.think({ manual: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /触犯主人约束/);
    assert.equal(e.status().project, null, '被否决就不该立项');
    const rows = readLedger(ledgerPath(dir), { limit: 0 }).rows;
    const deny = rows.find((x) => x.kind === 'deny');
    assert.ok(deny, '否决要进账本');
    assert.equal(deny.verdict, 'reject');
    assert.equal(deny.payload.constraint, true);
  } finally { cleanup(dir); }
});

test('约束硬否决：不触犯的项目照常立项', () => {
  const dir = tmp();
  try {
    const e = createAutotelic({
      dir,
      cfgOf: () => ({ enabled: true, seeds: ['想想怎么把话说得像人'], constraintRules: '不要半夜说话' }),
    });
    const r = e.think({ manual: true });
    assert.equal(r.ok, true, r.reason || '');
    assert.ok(e.status().project);
  } finally { cleanup(dir); }
});

test('decide()：账本 recent().rows 正确喂进 planner，无 planner 明确报错', async () => {
  const dir = tmp();
  try {
    const plain = createAutotelic({ dir, cfgOf: () => ({ enabled: true }), log: () => {} });
    const noPlanner = await plain.decide();
    assert.equal(noPlanner.ok, false);
    assert.match(noPlanner.error, /未接线/);

    let seen = null;
    const planner = { decideRound: async (o) => { seen = o; return { outcome: 'all-dead', candidates: [], verdicts: [], tickets: [] }; } };
    const e = createAutotelic({ dir, cfgOf: () => ({ enabled: true }), log: () => {}, planner });
    e.think({ manual: true }); // 造一条账本行
    const r = await e.decide({ round: 2 });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(seen.observations), 'observations 应是数组');
    assert.ok(seen.observations.length > 0, '账本里那行要喂进观察窗');
  } finally { cleanup(dir); }
});
