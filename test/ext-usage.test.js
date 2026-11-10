/**
 * 阶段 2 / 门 G2：usage section、instructions 过滤（P2 选定的 B）、工具输出 4 KB。
 *
 * 全是**夹具模拟的会话 scope**，不依赖 `/v1` 与真 DSH 进程：
 * 完整独立会话的验收按 §10.1 留给 G3。夹具刻意模拟了官方两条行为 ——
 * `interpolate:true` 才做 `{{...}}` 模板替换、`system-prompt/assemble` 是
 * scope-filtered waterfall（`next()` 返回 assembly），所以断言能真的变红。
 *
 * 跑法：node --test test/ext-usage.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtRegistry, EXT_KIND } from '../src/ext-registry.js';
import {
  USAGE_ORDER_FALLBACK,
  USAGE_CHAR_LIMIT,
  USAGE_TOTAL_BYTE_LIMIT,
  TOOL_OUTPUT_BYTE_LIMIT,
  truncateChars,
  usageSectionName,
  usageText,
  createUsageSections,
  resolveUsageOrder,
  mountUsageSections,
  mountInstructionFilter,
  truncateToolContent,
  mountToolOutputBudget,
  createExtUsage,
} from '../src/ext-usage.js';

const bytesOf = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const SENTINEL = 'THIRD_PARTY_INSTRUCTIONS_SENTINEL';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-usage-'));
  // 照 test/mood.test.js：Windows 上 rmSync 偶发 ENOTEMPTY，与被测代码无关。
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function manifest(id, over = {}) {
  return {
    api: 1, kind: EXT_KIND, id,
    name: `扩展 ${id}`, description: `默认说明 ${id}`,
    transport: 'stdio', command: 'node', args: ['./server.mjs'],
    serverName: id, ...over,
  };
}

/** 在临时 dataDir 里直接摆一个已装扩展目录（阶段 1 的落位另有专门测试）。 */
function seed(t, ids) {
  const home = tmpHome(t);
  const root = join(home, 'extensions');
  fs.mkdirSync(root, { recursive: true });
  for (const [id, over] of Object.entries(ids)) {
    const dir = join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest(id, over), null, 2), 'utf8');
  }
  return home;
}

/** 纯内存 registry 夹具，测 usage 预算时不用碰盘。 */
function fakeRegistry(entries) {
  const cache = new Map(Object.entries(entries));
  return {
    list: () => [...cache.keys()].sort().map((id) => ({ id })),
    liveUsage: (id) => cache.get(id) ?? '',
    refreshUsage: (id, v) => cache.set(id, v),
  };
}

/**
 * 模拟 DSH 的两种会话 scope：
 *   · `assemble('qq')` 只带 QQ ctx 注册的 section，不过 agent 的 scoped listener；
 *   · `assemble('agent')` 走 agent ctx 的 `system-prompt/assemble` waterfall。
 * `interpolate:true` 的 section 会被夹具替换 `{{key}}`，false 原样保留 —— 用来
 * 证明「`{{...}}` 不插值」不是靠夹具没实现插值混过去的。
 */
function fakeHarness({ globalSections = [], tools = ['tool_a', 'tool_b'], variables = {}, withOrder = true } = {}) {
  const mkCtx = () => {
    const ctx = { registered: [], listeners: [] };
    ctx.systemPrompt = {
      // 940 只是夹具里便于与 950 区分的**编造值**，不是官方实测返回值；
      // 真机 getSectionOrder('MCP_SERVERS') 的取值留 G3 复验记录。
      ...(withOrder ? { getSectionOrder: (k) => (k === 'MCP_SERVERS' ? 940 : 0) } : {}),
      section(desc) {
        const rec = { desc, disposed: false };
        ctx.registered.push(rec);
        return async () => { rec.disposed = true; };
      },
    };
    ctx.on = (event, fn) => {
      const rec = { event, fn };
      ctx.listeners.push(rec);
      return async () => { const i = ctx.listeners.indexOf(rec); if (i >= 0) ctx.listeners.splice(i, 1); };
    };
    return ctx;
  };
  const qq = mkCtx();
  const agent = mkCtx();
  const render = (desc) => {
    let text = typeof desc.text === 'function' ? desc.text() : desc.text;
    if (desc.interpolate) text = String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] ?? '');
    return String(text);
  };
  const ownSections = (ctx) => ctx.registered.filter((r) => !r.disposed)
    .map((r) => ({ name: r.desc.name, text: render(r.desc) }));

  async function assemble(which) {
    const own = which === 'qq' ? ownSections(qq) : [];
    const base = { sections: [...globalSections, ...own], contexts: [], tools: [...tools], variables: {} };
    let carry = () => Promise.resolve(base);
    const ls = which === 'agent'
      ? agent.listeners.filter((x) => x.event === 'system-prompt/assemble')
      : [];
    for (const rec of [...ls].reverse()) {
      const inner = carry;
      carry = () => rec.fn(base, {}, inner);
    }
    return carry();
  }
  return { qq, agent, assemble, tools };
}

function fakeToolsCtx() {
  const listeners = [];
  return {
    on(event, fn) {
      const rec = { event, fn };
      listeners.push(rec);
      return async () => { const i = listeners.indexOf(rec); if (i >= 0) listeners.splice(i, 1); };
    },
    async postExecute(exec, result, terminal = { kind: 'accept' }) {
      let carry = () => Promise.resolve(terminal);
      for (const rec of [...listeners].reverse()) {
        const inner = carry;
        carry = () => rec.fn(exec, result, inner);
      }
      return carry();
    },
  };
}

// ---------------------------------------------------------------- registry cache

test('usageCache：list() 填充、默认文案、liveUsage 零 IO', (t) => {
  const home = seed(t, { bili: {} });
  const reg = createExtRegistry({ dir: home });
  assert.deepEqual(reg.list().map((x) => x.id), ['bili']);
  assert.equal(reg.liveUsage('bili'), `扩展 bili：默认说明 bili`);

  // 把清单文件删掉：liveUsage 仍应返回内存值，证明 section 的 text() 不读盘。
  fs.rmSync(join(home, 'extensions', 'bili', 'plugin.json'));
  assert.equal(reg.liveUsage('bili'), `扩展 bili：默认说明 bili`);
});

test('usageCache：usage 字段覆盖自动文案，refreshUsage 是失效钩子', (t) => {
  const home = seed(t, { bili: { usage: '{{TOKEN}} 字面说明' } });
  const reg = createExtRegistry({ dir: home });
  reg.list();
  assert.equal(reg.liveUsage('bili'), '{{TOKEN}} 字面说明');
  fs.writeFileSync(
    join(home, 'extensions', 'bili', 'plugin.json'),
    JSON.stringify(manifest('bili', { usage: '面板改过的新说明' })), 'utf8',
  );
  assert.equal(reg.liveUsage('bili'), '{{TOKEN}} 字面说明', '不刷新就不该变（零 IO）');
  assert.equal(reg.refreshUsage('bili'), '面板改过的新说明');
  assert.equal(reg.liveUsage('bili'), '面板改过的新说明');
});

test('usageCache：清单瞬时无效不清 cache（面板改过的说明不被扫描打回）', (t) => {
  const home = seed(t, { bili: { usage: '面板改过的说明' } });
  const reg = createExtRegistry({ dir: home });
  reg.list();
  assert.equal(reg.liveUsage('bili'), '面板改过的说明');
  fs.writeFileSync(join(home, 'extensions', 'bili', 'plugin.json'), '{ 坏 JSON', 'utf8');
  assert.deepEqual(reg.list(), []);
  assert.equal(reg.liveUsage('bili'), '面板改过的说明', '目录还在，cache 不该被清掉');
});

test('usageCache：install / remove 自动刷新，卸载后不残留', (t) => {
  const home = tmpHome(t);
  const src = join(home, 'bili');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(join(src, 'plugin.json'), JSON.stringify(manifest('bili')), 'utf8');
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.install(src, { source: { repo: 'market' } }).ok, true);
  assert.match(reg.liveUsage('bili'), /默认说明 bili/);
  assert.equal(reg.remove('bili').ok, true);
  assert.equal(reg.liveUsage('bili'), '');
});

// ---------------------------------------------------------------- usage sections

test('G2-1 usage 从清单生成：name / order / interpolate:false / text 是函数', () => {
  const reg = fakeRegistry({ bili: '读取动态' });
  const { sections, render } = createUsageSections(reg, { order: 940 });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, usageSectionName('bili'));
  assert.equal(sections[0].order, 940);
  assert.equal(sections[0].interpolate, false);
  assert.equal(typeof sections[0].text, 'function');
  assert.match(sections[0].text(), /【扩展：bili】读取动态（工具：mcp__bili__\*）/);
  assert.equal(render().bytes, bytesOf(sections[0].text()));
});

// ⚠️ 夹具级：夹具自己实现 `{{...}}` 替换，证明的是「我们设了 interpolate:false
// 且 text 按字面保留」。官方渲染器在「函数 text + interpolate:false」下的
// 真机语义留 G3 补一条断言（§10.1 门 G2 明确允许夹具验本阶段组件）。
test('G2-2 {{...}} 不插值：夹具能插值，但 usage 仍按字面保留', async () => {
  const reg = fakeRegistry({ bili: '口令是 {{TOKEN}}' });
  const h = fakeHarness({ variables: { TOKEN: 'SHOULD_NOT_APPEAR' } });
  const mounted = mountUsageSections(h.qq, reg, { order: 940 });
  // 对照组：夹具确实会替换 interpolate:true 的段，否则这条断言没意义。
  h.qq.systemPrompt.section({ name: 'control', order: 1, interpolate: true, text: '{{TOKEN}}' });
  const qq = await h.assemble('qq');
  const usage = qq.sections.find((s) => s.name === 'ext:bili:usage');
  assert.ok(usage.text.includes('{{TOKEN}}'));
  assert.ok(!usage.text.includes('SHOULD_NOT_APPEAR'));
  assert.equal(qq.sections.find((s) => s.name === 'control').text, 'SHOULD_NOT_APPEAR');
  assert.equal(mounted.sections[0].interpolate, false);
});

test('G2-3 单条 200 字截断并记 warn', () => {
  const warns = [];
  const reg = fakeRegistry({ bili: '长'.repeat(400) });
  const { sections, render } = createUsageSections(reg, { log: { warn: (m) => warns.push(m) } });
  const text = sections[0].text();
  assert.equal(Array.from(text).length, USAGE_CHAR_LIMIT, '单条恰好截到 200 字');
  assert.ok(!text.includes('…（已截断）'), '单条字数截断不追加合计标记');
  assert.ok(render().truncated.some((x) => x.why.includes('200 字')));
  assert.ok(warns.some((m) => m.includes('bili')));
  assert.equal(truncateChars('abc', 2).text, 'ab');
});

test('G2-4 合计 2 KB 截断：总字节不超预算、超额扩展记 warn', () => {
  const warns = [];
  const entries = {};
  for (let i = 0; i < 6; i++) entries[`ext${i}`] = '字'.repeat(180);
  const reg = fakeRegistry(entries);
  const { sections, render } = createUsageSections(reg, { log: { warn: (m) => warns.push(m) } });
  const texts = sections.map((s) => s.text());
  const total = texts.reduce((n, s) => n + bytesOf(s), 0);
  assert.ok(total <= USAGE_TOTAL_BYTE_LIMIT, `实际 ${total} 字节`);
  assert.ok(render().truncated.some((x) => x.why.includes('2 KB')));
  assert.ok(warns.length >= 1);
  // 预算耗尽后的整条消失（空串）与「带标注截断」是两种行为，都锁住防回归。
  assert.equal(texts.at(-1), '');
  assert.equal(texts.filter((s) => s.includes('…（已截断）')).length, 1, '标注只加在首个被字节截的条上');
});

test('G2-5 动态 text：面板改 usage 后下一个请求生效，无需重启 / 重载', () => {
  const reg = fakeRegistry({ bili: '旧说明' });
  const { sections } = createUsageSections(reg, { order: 940 });
  assert.match(sections[0].text(), /旧说明/);
  reg.refreshUsage('bili', '新说明');
  assert.match(sections[0].text(), /新说明/);
  assert.ok(!sections[0].text().includes('旧说明'));
});

test('G2-6 order 校准：优先官方 getSectionOrder，取不到才回退 950 并 warn', () => {
  const h = fakeHarness();
  assert.equal(resolveUsageOrder(h.qq.systemPrompt), 940);
  const warns = [];
  assert.equal(resolveUsageOrder({}, { warn: (m) => warns.push(m) }), USAGE_ORDER_FALLBACK);
  assert.ok(warns.some((m) => m.includes('950')));
  assert.equal(usageText({ id: 'a-b', usage: 'x' }), '【扩展：a-b】x（工具：mcp__a-b__*）');
});

test('G2-7 关扩展 / 关会话：disposer 整组撤销', async () => {
  const reg = fakeRegistry({ bili: 'a', douyu: 'b' });
  const h = fakeHarness();
  const mounted = mountUsageSections(h.qq, reg);
  assert.equal(h.qq.registered.length, 2);
  await mounted.dispose();
  assert.equal(h.qq.registered.every((r) => r.disposed), true);
  assert.deepEqual((await h.assemble('qq')).sections.filter((s) => s.name.startsWith('ext:')), []);
});

// ---------------------------------------------------------------- instructions 过滤

test('G2-8 B 过滤：独立会话挡住非空 instructions，工具表 / 人格 / 记忆都还在', async () => {
  const h = fakeHarness({
    globalSections: [
      { name: 'mcp:probe', text: SENTINEL },
      { name: 'roost-persona', text: '人格还在' },
      { name: 'roost-memory', text: '记忆还在' },
      { name: 'ext:bili:usage', text: 'usage 也在' },
    ],
  });
  const off = mountInstructionFilter(h.agent);
  const agent = await h.assemble('agent');
  assert.ok(!JSON.stringify(agent.sections).includes(SENTINEL));
  assert.ok(agent.sections.some((s) => s.name === 'roost-persona'));
  assert.ok(agent.sections.some((s) => s.name === 'roost-memory'));
  assert.ok(agent.sections.some((s) => s.name === 'ext:bili:usage'), '只过滤 mcp: 前缀');
  assert.deepEqual(agent.tools, h.tools, 'tool declarations 原样保留');
  await off();
});

test('G2-9 QQ 会话不受影响：instructions 仍在、usage 只注册在 QQ 会话', async () => {
  const reg = fakeRegistry({ bili: '读取动态' });
  const h = fakeHarness({ globalSections: [{ name: 'mcp:probe', text: SENTINEL }] });
  const usage = mountUsageSections(h.qq, reg);
  const off = mountInstructionFilter(h.agent);
  const qq = await h.assemble('qq');
  const agent = await h.assemble('agent');
  assert.ok(JSON.stringify(qq.sections).includes(SENTINEL));
  assert.ok(qq.sections.some((s) => s.name === 'ext:bili:usage'));
  assert.ok(agent.sections.every((s) => !s.name.startsWith('ext:')), '独立会话默认不注册 usage（§9-#19）');
  assert.ok(!JSON.stringify(agent.sections).includes(SENTINEL));
  await off();
  await usage.dispose();
});

test('G2-10 disposer 真撤销：关会话后独立会话恢复可见', async () => {
  const h = fakeHarness({ globalSections: [{ name: 'mcp:probe', text: SENTINEL }] });
  const off = mountInstructionFilter(h.agent);
  assert.ok(!JSON.stringify((await h.assemble('agent')).sections).includes(SENTINEL));
  await off();
  assert.equal(h.agent.listeners.length, 0);
  assert.ok(JSON.stringify((await h.assemble('agent')).sections).includes(SENTINEL));
});

test('G2-11 不注册 complete、不改 tools、非 mcp: section 一个不少', async () => {
  const h = fakeHarness({
    globalSections: [
      { name: 'mcp:one', text: SENTINEL },
      { name: 'mcp:two', text: SENTINEL },
      { name: 'roost-persona', text: '人格' },
    ],
  });
  const off = mountInstructionFilter(h.agent);
  const out = await h.assemble('agent');
  assert.deepEqual(out.sections.map((s) => s.name), ['roost-persona']);
  assert.ok(!('complete' in out));
  assert.deepEqual(out.tools, h.tools);
  assert.deepEqual(out.contexts, []);
  await off();
});

// ---------------------------------------------------------------- 工具输出 4 KB

test('G2-12 超 4 KB 截断并标注，总字节不超上限、中文不切半个字符', () => {
  const big = '中'.repeat(3000); // 9000 字节
  const cut = truncateToolContent([{ type: 'text', text: big }]);
  assert.equal(cut.truncated, true);
  assert.ok(cut.originalBytes > TOOL_OUTPUT_BYTE_LIMIT);
  const total = cut.content.reduce((n, b) => n + (b.type === 'text' ? bytesOf(b.text) : 0), 0);
  assert.ok(total <= TOOL_OUTPUT_BYTE_LIMIT, `实际 ${total} 字节`);
  assert.match(cut.content.at(-1).text, /已截断/);
  assert.equal(cut.content[0].text.includes('\uFFFD'), false);
  assert.equal(Buffer.from(cut.content[0].text, 'utf8').toString('utf8'), cut.content[0].text);
});

test('G2-13 未超上限原样返回（同一引用），超限丢弃图片块', () => {
  const small = [{ type: 'text', text: 'ok' }];
  assert.equal(truncateToolContent(small).content, small);
  const withImage = [
    { type: 'text', text: '中'.repeat(3000) },
    { type: 'image', data: 'AAAA' },
  ];
  const cut = truncateToolContent(withImage);
  assert.equal(cut.truncated, true);
  assert.ok(cut.content.every((b) => b.type !== 'image'));
  assert.equal(truncateToolContent(null).truncated, false);
});

test('G2-13b P1 回归：纯图片 / 二进制大结果也进 4 KB 预算，不静默绕过', () => {
  const cut = truncateToolContent([{ type: 'image', data: 'A'.repeat(20000), mimeType: 'image/png' }]);
  assert.equal(cut.truncated, true);
  assert.ok(cut.originalBytes > TOOL_OUTPUT_BYTE_LIMIT);
  assert.ok(cut.content.every((b) => b.type !== 'image'));
  assert.match(cut.content.at(-1).text, /已截断/);
  const mixed = truncateToolContent([{ type: 'text', text: 'ok' }, { type: 'image', data: 'A'.repeat(20000) }]);
  assert.equal(mixed.truncated, true);
  assert.equal(mixed.content[0].text, 'ok');
});

test('G2-14 waterfall：block / 已有 value 原样放行，不吞掉别人的决策', async () => {
  const ctx = fakeToolsCtx();
  const off = mountToolOutputBudget(ctx);
  const result = { content: [{ type: 'text', text: '中'.repeat(3000) }] };
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: '不许用' }] };
  assert.deepEqual(await ctx.postExecute({}, result, blocked), blocked);
  const valued = { kind: 'accept', value: { secret: 1 }, content: result.content };
  assert.deepEqual(await ctx.postExecute({}, result, valued), valued);
  assert.equal((await ctx.postExecute({}, { content: [{ type: 'text', text: 'short' }] })).kind, 'accept');
  await off();
});

test('G2-15 waterfall：替换 content 但 spread 保留 additionalContexts 等字段', async () => {
  const ctx = fakeToolsCtx();
  const off = mountToolOutputBudget(ctx);
  const extra = [{ type: 'text', text: '补充上下文' }];
  const out = await ctx.postExecute(
    { name: 'mcp__bili__feed' },
    { content: [{ type: 'text', text: '中'.repeat(3000) }] },
    { kind: 'accept', additionalContexts: extra },
  );
  assert.equal(out.kind, 'accept');
  assert.deepEqual(out.additionalContexts, extra);
  assert.match(out.content.at(-1).text, /已截断/);
  await off();
});

// ---------------------------------------------------------------- 聚合入口

test('G2-16 createExtUsage 统一撤销三个挂载', async () => {
  const reg = fakeRegistry({ bili: 'x' });
  const h = fakeHarness();
  const tools = fakeToolsCtx();
  const ext = createExtUsage({ registry: reg });
  ext.mountUsage(h.qq);
  ext.mountFilter(h.agent);
  ext.mountOutputBudget(tools);
  await ext.dispose();
  assert.equal(h.qq.registered.every((r) => r.disposed), true);
  assert.equal(h.agent.listeners.length, 0);
  assert.equal((await tools.postExecute({}, { content: [] })).kind, 'accept');
});
