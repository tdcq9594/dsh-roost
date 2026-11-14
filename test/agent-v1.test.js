/**
 * 阶段 3.3 / 门 G3：独立 Agent 会话接线。
 *
 * 用夹具模拟 `ctx.agents.create()`（async、handle 形状 `{agent:{ctx},dispose}`）、
 * `agent.ctx.systemPrompt.section()`、`system-prompt/assemble` scoped listener、
 * `agent.ctx.effect()` 与 SSE 响应。真机 DSH 差异（handle 形状、prompt 流式 API）
 * 按 §10.1 留 G3 复验，本测试锁住的是**接线本身**。
 *
 * 跑法：node --test test/agent-v1.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createAgentV1, SESSIONS_FILE } from '../src/agent-v1.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-agent-v1-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function makeCtx() {
  const registered = [];
  const listeners = [];
  const ctx = {
    registered, listeners,
    systemPrompt: {
      getSectionOrder: () => 940,
      section(desc) {
        const rec = { desc, disposed: false };
        registered.push(rec);
        return async () => { rec.disposed = true; };
      },
    },
    on(event, fn) {
      const rec = { event, fn };
      listeners.push(rec);
      return async () => { const i = listeners.indexOf(rec); if (i >= 0) listeners.splice(i, 1); };
    },
    effect(cleanupFactory) {
      return async () => { await cleanupFactory()?.(); };
    },
  };
  return ctx;
}

function fakeAgents() {
  const made = [];
  const svc = {
    async create({ sessionId }) {
      const agentCtx = makeCtx();
      const handle = {
        agent: {
          ctx: agentCtx,
          async prompt(text) { return [`回复一：${text}`, '回复二']; },
        },
        disposed: false,
        dispose: async () => { handle.disposed = true; },
      };
      made.push({ sessionId, handle, agentCtx });
      return handle;
    },
  };
  return { svc, made };
}

function fakeSseRes() {
  const chunks = [];
  return {
    chunks, headersSent: false, writableEnded: false, headers: {},
    writeHead(code, headers) { this.status = code; this.headers = headers; this.headersSent = true; },
    write(s) { chunks.push(s); },
    end(s) { if (s) chunks.push(s); this.writableEnded = true; },
  };
}

const fakeSend = (res) => (code, body) => { res.status = code; res.body = body; return res; };

test('G3-17 agent.new：sections 按自带 name 注册、一律做 B 过滤、不注册 usage', async (t) => {
  const dir = tmpHome(t);
  const { svc, made } = fakeAgents();
  const a = createAgentV1({ dir, agents: svc });
  const out = await a.handleHook({
    key: 'POST /v1/agent.new',
    body: { clientId: 'game-ref', sections: [{ name: 'judge-rules', order: 910, text: '裁判规则' }, { name: 'judge-style', text: '简洁' }] },
    req: { url: '/' }, res: null, send: () => {},
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(out.body.registeredSections, ['judge-rules', 'judge-style']);
  assert.deepEqual(out.body.filtered, ['mcp:*']);
  assert.equal(out.body.usageRegistered, false);
  const ctx = made[0].agentCtx;
  assert.deepEqual(ctx.registered.map((r) => r.desc.name), ['judge-rules', 'judge-style']);
  assert.equal(ctx.registered[0].desc.interpolate, false);
  assert.ok(ctx.listeners.some((l) => l.event === 'system-prompt/assemble'), 'B 过滤 listener 已挂在该会话 ctx');
  assert.ok(ctx.registered.every((r) => !r.desc.name.startsWith('ext:')));
});

test('G3-18 agent.close：整组 disposer 撤销 + handle.dispose，list 变空', async (t) => {
  const dir = tmpHome(t);
  const { svc, made } = fakeAgents();
  const a = createAgentV1({ dir, agents: svc });
  const one = await a.handleHook({ key: 'POST /v1/agent.new', body: { sections: [{ name: 'r', text: 'x' }] }, req: { url: '/' } });
  const id = one.body.sessionId;
  const ctx = made[0].agentCtx;
  assert.equal((await a.handleHook({ key: 'GET /v1/agent.list' })).body.sessions.length, 1);
  const closed = await a.handleHook({ key: 'POST /v1/agent.close', body: { sessionId: id } });
  assert.equal(closed.body.ok, true);
  assert.equal(closed.body.disposed, 2, '1 个 section + 1 个 filter');
  assert.ok(ctx.registered.every((r) => r.disposed));
  assert.equal(ctx.listeners.length, 0);
  assert.equal(made[0].handle.disposed, true);
  assert.equal((await a.handleHook({ key: 'GET /v1/agent.list' })).body.sessions.length, 0);
});

test('G3-19 agent.prompt：SSE 流式 / ?wait=1 聚合 / 会话不存在 404', async (t) => {
  const dir = tmpHome(t);
  const { svc } = fakeAgents();
  const a = createAgentV1({ dir, agents: svc });
  const one = await a.handleHook({ key: 'POST /v1/agent.new', body: { sections: [] }, req: { url: '/' } });
  const id = one.body.sessionId;

  const res = fakeSseRes();
  const streamed = await a.handleHook({
    key: 'POST /v1/agent.prompt', body: { sessionId: id, text: '谁赢了' },
    req: { url: '/v1/agent.prompt' }, res, send: fakeSend(res),
  });
  assert.equal(streamed.streamed, true);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(res.chunks.some((c) => c.includes('回复一：谁赢了')));
  assert.ok(res.chunks.some((c) => c.includes('event: done')));
  assert.equal(res.writableEnded, true);

  const plain = { headersSent: false, writableEnded: false };
  const waited = await a.handleHook({
    key: 'POST /v1/agent.prompt', body: { sessionId: id, text: '再来' },
    req: { url: '/v1/agent.prompt?wait=1' }, res: plain, send: fakeSend(plain),
  });
  assert.equal(waited.status, 200);
  assert.equal(waited.body.text, '回复一：再来回复二');
  const missing = await a.handleHook({ key: 'POST /v1/agent.prompt', body: { sessionId: 'nope', text: 'x' }, req: { url: '/' } });
  assert.equal(missing.status, 404);
});

test('G3-20 persist 快照：写 agent-sessions.json、restore 重新注册、close 清快照', async (t) => {
  const dir = tmpHome(t);
  const { svc, made } = fakeAgents();
  const a = createAgentV1({ dir, agents: svc });
  const one = await a.handleHook({
    key: 'POST /v1/agent.new',
    body: { clientId: 'g', persist: true, sections: [{ name: 'rules', text: 'r' }] },
    req: { url: '/' },
  });
  const id = one.body.sessionId;
  const file = join(dir, SESSIONS_FILE);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snap.sessions.length, 1);
  assert.deepEqual(snap.sessions[0].sections.map((s) => s.name), ['rules']);
  assert.equal(snap.sessions[0].sections[0].text, 'r', '规则快照必须存正文，不能只存 name/order');

  await a.dispose();
  assert.equal(made[0].handle.disposed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sessions, [], '关会话要把快照清掉');

  // 模拟备份还原：把真实快照写回去，restore 按 id 重建 section（含规则正文）。
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ sessionId: id, clientId: 'g', sections: [{ name: 'rules', order: 900, text: 'r' }], createdAt: 1 }] }), 'utf8');
  const b = createAgentV1({ dir, agents: svc });
  const r = await b.restore();
  assert.equal(r.restored, 1);
  assert.equal(b.list().length, 1);
  const restored = made.at(-1).agentCtx.registered.find((x) => x.desc.name === 'rules');
  assert.ok(restored);
  assert.equal(restored.desc.text(), 'r', '恢复后的 section 文本不能为空');
  await b.dispose();
});

test('G3-21 坏输入：section 缺 name / agents 服务不可用；重复 sessionId 走 ensure 复用', async (t) => {
  const dir = tmpHome(t);
  const { svc } = fakeAgents();
  const a = createAgentV1({ dir, agents: svc });
  const bad = await a.handleHook({ key: 'POST /v1/agent.new', body: { sections: [{ text: 'no name' }] }, req: { url: '/' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /name/);
  const one = await a.handleHook({ key: 'POST /v1/agent.new', body: { sessionId: 'dup' }, req: { url: '/' } });
  assert.equal(one.status, 200);
  const dup = await a.handleHook({ key: 'POST /v1/agent.new', body: { sessionId: 'dup' }, req: { url: '/' } });
  /**
   * 2026-11-14：`/v1/agent.new` 改成 aurabot `agentFor()` 那样的 ensure 语义。
   * 扩展每轮都拿固定 `bili-duty` 调它，重复 id 不该 400 —— 以前一报 400，
   * 扩展把 already exists 吞成成功，接着 /agent.prompt 就 404「没起会话」。
   */
  assert.equal(dup.status, 200);
  assert.equal(dup.body.reused, true);
  const none = createAgentV1({ dir, agents: null, ctx: null });
  const noSvc = await none.handleHook({ key: 'POST /v1/agent.new', body: {}, req: { url: '/' } });
  assert.equal(noSvc.status, 400);
});
