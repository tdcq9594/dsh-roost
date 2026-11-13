/**
 * `/v1/agent.*` 独立 Agent 会话（方案 §6.3 / 实施阶段 3.3）。
 *
 * 与 QQ 会话完全隔离：**不写 `sessions.json`**、不按 chatId 找身份、不受 quota
 * 与能力页拦截（§9-#4 主人决策）。用 `ctx.agents.create()` 开会话，在该会话的
 * `agent.ctx` 上注册自带 name 的 sections，并接线阶段 2.1 选定的 **B 过滤模块**。
 *
 * 关会话 / 插件 teardown 时整组 disposer 撤销；官方 practices 要求把 per-agent
 * 注册包在 `agent.ctx.effect()` 里（插件卸载不会自动 dispose agent.ctx 上的注册），
 * 这里在可用的情况下包一层，同时自己保存 disposer 作兜底。
 *
 * `agents`（`ctx.agents` 服务）与 `promptFn` 可注入：官方 `create()` 是 async、
 * handle 形状在不同版本是 `{agent, dispose}` 或 `{ctx, dispose}`，两种都兼容；
 * 不把 API 形状写死，夹具能完整验接线，真机差异留 G3 复验。
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './config.js';
import { mountInstructionFilter, invokeDisposer } from './ext-usage.js';

export const SESSIONS_FILE = 'agent-sessions.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

const chunkText = (c) => {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    for (const k of ['text', 'delta', 'content', 'message']) {
      if (typeof c[k] === 'string') return c[k];
    }
  }
  return '';
};

/** 默认流式：优先 prompt()，其次 run()；支持 string / async iterable / 普通返回值。 */
async function defaultPromptFn(handle, text, onChunk) {
  const agent = handle?.agent ?? handle;
  const fn = typeof agent?.prompt === 'function' ? agent.prompt.bind(agent)
    : (typeof agent?.run === 'function' ? agent.run.bind(agent) : null);
  if (!fn) throw new Error('DSH agent 未提供 prompt()/run()，无法流式输出');
  const out = await fn(text);
  if (out && typeof out[Symbol.asyncIterator] === 'function') {
    for await (const chunk of out) onChunk(chunkText(chunk));
  } else if (out && typeof out !== 'string' && typeof out[Symbol.iterator] === 'function') {
    // 有些实现一次返回分片数组；string 也有 iterator，必须排除否则会按字符吐。
    for (const chunk of out) onChunk(chunkText(chunk));
  } else {
    onChunk(chunkText(out));
  }
}

export function createAgentV1({
  dir = dataDir(),
  ctx = null,
  agents = null,
  log = () => {},
  promptFn = defaultPromptFn,
  now = () => Date.now(),
} = {}) {
  const file = join(dir, SESSIONS_FILE);
  const sessions = new Map();
  let disposed = false; // teardown 后拦住延迟到达的 restore()，避免会话残留

  const agentsOf = () => agents ?? (typeof ctx?.get === 'function' ? ctx.get('agents') : null);

  function snapshot() {
    const rows = [];
    for (const [sessionId, s] of sessions) {
      if (!s.persist) continue;
      rows.push({
        sessionId, clientId: s.clientId, sections: s.sections.map((x) => ({ ...x })),
        preset: s.preset ?? null, createdAt: s.createdAt,
      });
    }
    writeJsonAtomic(file, { sessions: rows });
  }

  function ctxOf(handle) {
    return handle?.agent?.ctx ?? handle?.ctx ?? null;
  }

  async function createOne({ clientId = '', persist = false, preset = null, sections = [], sessionId: given = '', resume = false } = {}) {
    const svc = agentsOf();
    if (!svc || typeof svc.create !== 'function') throw new Error('ctx.agents 服务不可用');
    const sessionId = given || `agent-${randomUUID()}`;
    if (sessions.has(sessionId)) throw new Error(`会话已存在：${sessionId}`);
    // 官方 create 是 async；同步调用只会拿 Promise。备份还原走 resume 优先，
    // 老版本没有 resume 时退回 create（§6.3「恢复后按 id 拉回」）。
    const handle = resume && typeof svc.resume === 'function'
      ? await svc.resume(sessionId)
      : await svc.create({ sessionId, persist: !!persist, preset });
    const agentCtx = ctxOf(handle);
    if (!agentCtx) throw new Error('agents.create()/resume() 返回的 handle 上没有会话 ctx');

    const offs = [];
    const names = [];
    for (const one of sections) {
      if (!one || typeof one.name !== 'string' || !one.name) throw new Error('section 缺 name');
      const sp = agentCtx.systemPrompt ?? agentCtx.get?.('systemPrompt');
      if (typeof sp?.section !== 'function') throw new Error('会话 ctx 上没有 systemPrompt.section()');
      offs.push(sp.section({
        name: one.name,
        order: Number.isFinite(one.order) ? one.order : 900,
        interpolate: false,
        text: typeof one.text === 'function' ? one.text : () => String(one.text ?? ''),
      }));
      names.push(one.name);
    }

    // 独立会话**一律**做 instructions 过滤，不接受客户端传入、也不注册 usage。
    // 直接用底层注册函数：disposer 只归本会话的 rec.offs 管，撤销路径唯一，
    // 不经聚合入口的全局 Set（那样关会话后会留条目、还会重复 dispose）。
    offs.push(mountInstructionFilter(agentCtx));

    // 官方 practices：per-agent 注册要包在 agent.ctx.effect() 里，插件卸载时
    // 才不会把 listener 留在活着的 agent 上。老版本没有 effect 就跳过，靠自己
    // 保存的 disposer 兜底（teardown 会调 dispose()）。
    let effectOff = null;
    if (typeof agentCtx.effect === 'function') {
      try {
        effectOff = agentCtx.effect(() => () => { void closeOne(sessionId, { skipEffect: true }); });
      } catch { effectOff = null; }
    }

    // persist 快照必须存**规则正文**（§6.3「规则快照」）。只存 name/order 会让
    // 还原后的 section 文本恒为空 —— 裁判规则静默丢失且没有任何报错。
    const sectionRows = sections.map((x) => ({
      name: x.name,
      order: Number.isFinite(x.order) ? x.order : 900,
      text: typeof x.text === 'function' ? String(x.text()) : String(x.text ?? ''),
    }));
    const rec = {
      sessionId, clientId, preset, persist: !!persist, sections: sectionRows,
      createdAt: now(), handle, agentCtx, offs, effectOff, closed: false,
    };
    sessions.set(sessionId, rec);
    if (persist) snapshot();
    return {
      ok: true, sessionId, clientId, preset, persist: rec.persist,
      registeredSections: names, filtered: ['mcp:*'], usageRegistered: false,
    };
  }

  async function closeOne(sessionId, { skipEffect = false } = {}) {
    const rec = sessions.get(sessionId);
    if (!rec || rec.closed) return { ok: false, error: 'not_found', message: '会话不存在或已关闭' };
    rec.closed = true;
    for (const off of [...rec.offs].reverse()) await invokeDisposer(off);
    if (!skipEffect) await invokeDisposer(rec.effectOff);
    await invokeDisposer(rec.handle?.dispose);
    sessions.delete(sessionId);
    if (rec.persist) snapshot();
    return { ok: true, sessionId, disposed: rec.offs.length };
  }

  function sse(res, sessionId) {
    if (!res?.writeHead || !res?.write) throw new Error('SSE 需要真实的 ServerResponse');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: start\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    return (chunk) => {
      if (chunk) res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
    };
  }

  /** `/v1/agent.*` 的统一 hook（`api-v1.js` 的 `hooks.agent`）。 */
  async function handleHook({ key, body = {}, req, res, send } = {}) {
    if (key === 'GET /v1/agent.list') {
      const rows = [...sessions.values()].filter((s) => !s.closed).map((s) => ({
        sessionId: s.sessionId, clientId: s.clientId, persist: s.persist,
        sections: s.sections.map((x) => x.name), createdAt: s.createdAt,
      }));
      return { status: 200, body: { ok: true, sessions: rows } };
    }
    if (key === 'POST /v1/agent.new') {
      try {
        const out = await createOne({
          clientId: String(body.clientId ?? ''),
          persist: !!body.persist,
          preset: body.preset ?? null,
          sections: Array.isArray(body.sections) ? body.sections : [],
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        });
        return { status: 200, body: out };
      } catch (e) {
        return { status: 400, body: { ok: false, error: 'agent_create_failed', message: String(e?.message ?? e) } };
      }
    }
    if (key === 'POST /v1/agent.close') {
      return { status: 200, body: await closeOne(String(body.sessionId ?? '')) };
    }
    if (key === 'POST /v1/agent.prompt') {
      const rec = sessions.get(String(body.sessionId ?? ''));
      if (!rec || rec.closed) return { status: 404, body: { ok: false, error: 'not_found', message: '会话不存在' } };
      const text = String(body.text ?? '');
      if (!text) return { status: 400, body: { ok: false, error: 'empty_text' } };
      const wait = new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('wait') === '1';
      const chunks = [];
      try {
        if (!wait) {
          const emit = sse(res, rec.sessionId);
          await promptFn(rec.handle, text, (c) => { chunks.push(c); emit(c); });
          res.write(`event: done\ndata: ${JSON.stringify({ ok: true, chunks: chunks.length })}\n\n`);
          res.end();
          return { streamed: true }; // api-v1 看到 headersSent 会直接 return
        }
        await promptFn(rec.handle, text, (c) => chunks.push(c));
        return { status: 200, body: { ok: true, text: chunks.join('') } };
      } catch (e) {
        if (res?.headersSent) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: String(e?.message ?? e) })}\n\n`);
          res.end();
          return { streamed: true };
        }
        return { status: 502, body: { ok: false, error: 'prompt_failed', message: String(e?.message ?? e) } };
      }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } };
  }

  return {
    handleHook,
    createOne,
    /**
     * 在已建好的独立会话里跑一轮，返回收集到的文本。
     *
     * 给自驱引擎用（`src/autotelic.js` 的 `run`）：它需要「建会话 → 跑一轮」
     * 但不需要 HTTP/SSE 那套。会话不存在时抛错，由调用方决定要不要先 createOne。
     */
    async prompt(sessionId, text, onChunk = () => {}) {
      const rec = sessions.get(String(sessionId ?? ''));
      if (!rec || rec.closed) throw new Error(`会话不存在：${sessionId}`);
      const chunks = [];
      await promptFn(rec.handle, String(text ?? ''), (c) => { chunks.push(c); onChunk(c); });
      return chunks.join('');
    },
    closeOne,
    list: () => [...sessions.values()].filter((s) => !s.closed).map((s) => ({ sessionId: s.sessionId, clientId: s.clientId })),
    snapshot,
    /** 备份还原后按快照重新注册 section（会话本身由 DSH 按 id 拉回）。 */
    restore: async () => {
      if (disposed) return { restored: 0, reason: 'disposed' };
      const rows = readJson(file)?.sessions;
      if (!Array.isArray(rows)) return { restored: 0 };
      let n = 0;
      for (const row of rows) {
        try { await createOne({ ...row, persist: true, resume: true, sessionId: row.sessionId }); n++; }
        catch (e) { log.warn?.(`恢复会话 ${row.sessionId} 失败：${e?.message ?? e}`); }
      }
      return { restored: n };
    },
    dispose: async () => {
      disposed = true;
      for (const id of [...sessions.keys()]) await closeOne(id);
    },
  };
}
