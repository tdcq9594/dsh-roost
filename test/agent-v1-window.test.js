/**
 * 2026-11-14：独立会话必须走宿主那套「会话窗口」调用器，而不是
 * `agent-v1.js` 里只认 prompt()/run() 的兜底实现。
 *
 * 背景：运行时 `ctx.agents.create()` 给的 handle 只有 `followup()`，
 * 导致 `/v1/agent.prompt` 恒 502「DSH agent 未提供 prompt()/run()」，
 * 扩展点「现在刷一轮」只建了个空会话、模型一次都没跑。
 * 修法是 host.js 把 `turns.run`（src/turn.js，followup + session/event
 * + turn/end 收文本）注入成 `promptFn`。
 *
 * 跑法：node --test test/agent-v1-window.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createAgentV1 } from '../src/agent-v1.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-agent-window-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

/** 最小会话 ctx：instructions 过滤要 on()，section 要能注册 */
function makeCtx() {
  return {
    systemPrompt: {
      section: () => async () => {},
      getSectionOrder: () => 940,
    },
    on: () => async () => {},
    effect: () => async () => {},
  };
}

/**
 * 模拟真实运行时：`handle.agent` 只有 `followup()`，没有 prompt()/run()，
 * 也还没带 session.id / sessionId。
 */
function fakeAgents() {
  const made = [];
  const svc = {
    async create({ sessionId }) {
      const handle = {
        agent: {
          ctx: makeCtx(),
          async followup(msg) { made.push({ sessionId, msg }); },
        },
        dispose: async () => {},
      };
      return handle;
    },
  };
  return { svc, made };
}

test('createOne 给只有 followup 的 handle 补上 sessionId（turns.run 靠它认会话）', async (t) => {
  const { svc } = fakeAgents();
  const a = createAgentV1({ dir: tmpHome(t), agents: svc });
  const r = await a.createOne({ sessionId: 'bili-duty', clientId: 'bili' });
  assert.equal(r.ok, true);
  const rec = a.list().find((x) => x.sessionId === 'bili-duty');
  assert.ok(rec);
  /** 通过 handle 反查不到就直接验 promptFn 收到的 meta（下一个用例） */
});

test('注入 promptFn 后，/v1/agent.prompt 走窗口调用并拿回文本', async (t) => {
  const { svc } = fakeAgents();
  const calls = [];
  const promptFn = async (handle, text, onChunk, meta = {}) => {
    calls.push({ sid: handle?.agent?.sessionId, meta, text });
    const out = '{"items":[]}';
    onChunk(out);
    return out;
  };
  const a = createAgentV1({ dir: tmpHome(t), agents: svc, promptFn });
  await a.createOne({ sessionId: 'bili-duty', clientId: 'bili' });

  const r = await a.handleHook({
    key: 'POST /v1/agent.prompt',
    body: { sessionId: 'bili-duty', text: '这一轮刷到的视频：…' },
    req: { url: 'http://127.0.0.1/v1/agent.prompt?wait=1' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.text, '{"items":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sid, 'bili-duty', 'handle 上要能拿到会话 id');
  assert.equal(calls[0].meta.sessionId, 'bili-duty');
  assert.match(calls[0].text, /这一轮刷到的视频/);
});

test('不注入 promptFn 时，只有 followup 的 handle 仍明确报错（守门，不许静默假装修好）', async (t) => {
  const { svc } = fakeAgents();
  const a = createAgentV1({ dir: tmpHome(t), agents: svc });
  await a.createOne({ sessionId: 'bili-duty', clientId: 'bili' });
  const r = await a.handleHook({
    key: 'POST /v1/agent.prompt',
    body: { sessionId: 'bili-duty', text: '在吗' },
    req: { url: 'http://127.0.0.1/v1/agent.prompt?wait=1' },
  });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /未提供 prompt\(\)\/run\(\)/);
});

test('宿主把 turns.run 注入成 agentV1 的 promptFn（静态守门）', () => {
  const src = fs.readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(src, /createAgentV1\(\{[\s\S]{0,1200}?promptFn:/,
    'createAgentV1 必须注入 promptFn，否则运行时又退回 502');
  assert.match(src, /resolveAgent\(sid\)/,
    'promptFn 要从 ctx.agents 拿活 agent，不能直接用 agents.create() 的创建句柄');
  assert.match(src, /flush: false/,
    '独立会话必须跳过 sessions.flush：创建句柄是 closed，硬 flush 会 502「flush on a closed handle」');
  assert.match(src, /resolveAgentOf:/,
    'DSH 残留会话要靠宿主注入的 resolveAgentOf 恢复，不能只靠 create');
  assert.match(src, /applyDefaultModel\(sid, '', 'agent'\)/,
    '复用残留会话前必须补模型，否则第一轮 no provider/model 又会把宿主带崩');
  /** aurabot 式系统会话：侧栏能看见窗口，也不再受独立会话那串生命周期的折磨 */
  assert.match(src, /async function systemTurn\(/, '宿主要有 runSystemTurn 的对等实现');
  assert.match(src, /agentFor\(chat\)/, '系统会话必须走宿主自己的会话映射');
  assert.match(src, /systemTurn,/, '两处 runInProcessAction 都要把 systemTurn 注入给扩展');
});

/**
 * 2026-11-14 17:30 crash log：独立会话没配 provider/model，第一轮就抛
 * `agent "bili-duty" has no provider/model`，错误从 session/event observer
 * 冒泡成 `dsh: fatal load failure`，**整个宿主进程退出**。
 * 这两条守住「建会话时带模型 + 建完写一次 model/selection」。
 */
test('独立会话按 modelOf 带上 provider/model，且不传未校验的 thinking effort', async (t) => {
  const created = [];
  const selections = [];
  const svc = {
    async create(opts) {
      created.push(opts);
      return {
        agent: {
          ctx: makeCtx(),
          async followup() {},
          session: { id: 'bili-duty', append: (k, v) => selections.push(['append', k, v]) },
          model: { select: async (v) => selections.push(['select', v]) },
        },
        dispose: async () => {},
      };
    },
  };
  const a = createAgentV1({
    dir: tmpHome(t), agents: svc,
    modelOf: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
  });
  const r = await a.createOne({ sessionId: 'bili-duty', clientId: 'bili' });
  assert.equal(r.ok, true);
  assert.equal(created[0].provider, 'deepseek');
  assert.equal(created[0].model, 'deepseek-chat');
  assert.equal(created[0].reasoningEffort, undefined,
    'reasoningEffort 是 adapter 私有值，没经 resolveModelInfo 校验不许硬塞');
  assert.deepEqual(selections[0], ['select', { provider: 'deepseek', model: 'deepseek-chat' }]);
});

test('没有 agent.model.select 时退回写 model/selection 持久事件', async (t) => {
  const appended = [];
  const svc = {
    async create() {
      return {
        agent: {
          ctx: makeCtx(),
          async followup() {},
          session: { id: 'x', append: (k, v) => appended.push([k, v]) },
        },
        dispose: async () => {},
      };
    },
  };
  const a = createAgentV1({
    dir: tmpHome(t), agents: svc,
    modelOf: () => ({ provider: 'p', model: 'm' }),
  });
  await a.createOne({ sessionId: 'x' });
  assert.deepEqual(appended[0], ['model/selection', { provider: 'p', model: 'm' }]);
});

test('宿主给独立会话注入 modelOf（静态守门）', () => {
  const src = fs.readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(src, /createAgentV1\(\{[\s\S]{0,900}?modelOf: \(\) => pickModelFor/,
    'host.js 必须把默认模型解析成 modelOf 传给 createAgentV1，否则 API 建的会话拿不到模型');
});

test('一轮失败不许把异常抛回 Cordis observer（静态守门）', () => {
  const src = fs.readFileSync(new URL('../src/turn.js', import.meta.url), 'utf8');
  assert.match(src, /promise\.catch\(\(\) => \{\}\)/,
    '一轮失败的 rejection 要有空 handler，否则 DSH 判 fatal load failure');
  assert.match(src, /session\/event[\s\S]{0,400}?try \{/,
    'session/event 回调整段要包 try，异常不能冒泡到 Session.commit');
  assert.match(src, /不让它冒泡成 fatal/, 'catch 里要记日志说明原因');
});

/**
 * 2026-11-14 18:53 第五次「点了没起会话」：DSH 里 `bili-duty` 还在（崩过 /
 * 重启过），但宿主内存表空了，`agents.create()` 报 `already exists` →
 * /agent.new 400；扩展 `ensure()` 又把 already exists 吞成成功，接着
 * /agent.prompt 必然 404。aurabot 不会这样，它的 agentFor 是先查后建。
 */
test('agent.new 是 ensure 语义：同一个 id 再来一次直接复用，不报 400', async (t) => {
  const { svc } = fakeAgents();
  const a = createAgentV1({ dir: tmpHome(t), agents: svc });
  const body = { sessionId: 'bili-duty', clientId: 'bili' };
  const r1 = await a.handleHook({ key: 'POST /v1/agent.new', body });
  const r2 = await a.handleHook({ key: 'POST /v1/agent.new', body });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.reused, true, '第二次要标明是复用');
});

test('DSH 残留会话报 already exists 时不再 400，agent.prompt 能继续', async (t) => {
  /**
   * 运行时 `agents.resume()` 要的是 `{resumeSessionId, ...}`，不是字符串，
   * 所以这里故意让 resume 抛错：宿主必须不依赖它也能把会话登记下来，
   * 交给 promptFn 的 `resolveAgent(sid)` 去恢复活 agent。
   */
  const svc = {
    async create() { throw new Error('session "bili-duty" already exists'); },
    async resume() { throw new Error('旧签名不该被依赖'); },
  };
  const promptFn = async (h, text, onChunk) => {
    onChunk('{"items":[]}');
    return '{"items":[]}';
  };
  const a = createAgentV1({ dir: tmpHome(t), agents: svc, promptFn });
  const n = await a.handleHook({
    key: 'POST /v1/agent.new',
    body: { sessionId: 'bili-duty', clientId: 'bili', sections: [] },
  });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  const p = await a.handleHook({
    key: 'POST /v1/agent.prompt',
    body: { sessionId: 'bili-duty', text: '这一轮刷到的视频：…' },
    req: { url: 'http://127.0.0.1/v1/agent.prompt?wait=1' },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
});

test('get 拿不到时由宿主注入的 resolveAgentOf 恢复活 agent 并注册 sections', async (t) => {
  const live = { ctx: makeCtx(), session: { id: 'bili-duty' }, async followup() {} };
  let called = '';
  const svc = {
    async create() { throw new Error('session "bili-duty" already exists'); },
    async get() { return null; },
  };
  const a = createAgentV1({
    dir: tmpHome(t), agents: svc,
    resolveAgentOf: async (sid) => { called = sid; return live; },
    promptFn: async () => 'ok',
  });
  const n = await a.handleHook({
    key: 'POST /v1/agent.new',
    body: { sessionId: 'bili-duty', sections: [{ name: 'bili-duty', text: '规则' }] },
  });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  assert.equal(called, 'bili-duty');
  assert.deepEqual(n.body.registeredSections, ['bili-duty']);
});

test('老版本没有 resume 时退回 get() 拿活 agent 兜底', async (t) => {
  const live = { ctx: makeCtx(), session: { id: 'bili-duty' }, async followup() {} };
  const svc = {
    async create() { throw new Error('session "bili-duty" already exists'); },
    async get(sid) { return sid === 'bili-duty' ? live : null; },
  };
  const a = createAgentV1({ dir: tmpHome(t), agents: svc, promptFn: async () => 'ok' });
  const n = await a.handleHook({ key: 'POST /v1/agent.new', body: { sessionId: 'bili-duty' } });
  assert.equal(n.status, 200, JSON.stringify(n.body));
});
