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

/**
 * 兜底流式：优先 prompt()，其次 run()；支持 string / async iterable / 普通返回值。
 *
 * ⚠️ 真实运行时不走这里：`ctx.agents.create()` 给的 handle 只提供
 * `followup()`，没有 `prompt()/run()`，这个函数必然抛错（曾导致
 * `/v1/agent.prompt` 恒 502）。宿主 `host.js` 会注入 `turns.run` 作为
 * `promptFn`，走的是 `src/turn.js` 那套会话窗口投递。这里只留给不接宿主
 * 的单测（fake agent 提供 prompt()）和未来独立复用本模块的场景。
 */
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
  /** 宿主注入：返回 {provider, model} —— 独立会话没有 chatId，不显式套模型就会崩 */
  modelOf = () => null,
  /** 宿主注入：拿活 agent（ctx.agents.get → controller.resolveAgent），复用残留会话用 */
  resolveAgentOf = null,
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
    /**
     * `/v1/agent.new` 是 **ensure 语义**，不是「建一次就得关一次」。
     *
     * 扩展（bili）每轮都拿固定 `bili-duty` 调它，上一轮没关掉时不该报错；
     * aurabot 的 `agentFor()` 就是先查映射、有就复用、没有才建。以前这里
     * 无条件抛「会话已存在」，扩展的 `ensure()` 又把 already exists 吞成
     * 成功，于是会话没真建好却继续 /agent.prompt —— 必然 404。
     */
    const prev = sessions.get(sessionId);
    if (prev && !prev.closed) {
      return {
        ok: true, sessionId, clientId, preset: prev.preset, persist: prev.persist,
        registeredSections: prev.sections.map((x) => x.name),
        filtered: ['mcp:*'], usageRegistered: false, reused: true,
      };
    }
    if (prev) sessions.delete(sessionId);
    /**
     * 独立会话必须自带模型选择。
     *
     * DSH 的 `agentDefaultModel` 只兜 QQ 会话，API 建的会话拿不到，第一轮就抛
     * `agent "xxx" has no provider/model: set AgentOptions.provider and
     * AgentOptions.model or record a model selection`。而且这个错误会从
     * `session/event` observer 一路冒泡成 `dsh: fatal load failure`，**把整个
     * 宿主进程带崩**（2026-11-14 17:30 的 crash log）。
     *
     * 对齐 aurabot `applyModel()`：创建时带 provider/model，建完再写一次
     * `model/selection`。不传 reasoningEffort —— adapter 私有的不透明 id，
     * 没经过 `resolveModelInfo` 校验硬塞会在任何 provider I/O 之前直接失败。
     */
    let choice = null;
    try {
      const sel = modelOf?.();
      if (sel?.provider && sel?.model) {
        choice = { provider: String(sel.provider), model: String(sel.model) };
      }
    } catch { /* 取不到就退回宿主默认，别让建会话失败 */ }
    // 官方 create 是 async；同步调用只会拿 Promise。备份还原走 resume 优先，
    // 老版本没有 resume 时退回 create（§6.3「恢复后按 id 拉回」）。
    const createOpts = { sessionId, persist: !!persist, preset };
    if (choice) Object.assign(createOpts, choice);
    let handle = null;
    let reused = false;
    if (resume && typeof svc.resume === 'function') {
      try { handle = await svc.resume(sessionId); reused = Boolean(handle); } catch { handle = null; }
    }
    if (!handle) {
      try {
        handle = await svc.create(createOpts);
      } catch (e) {
        if (!/already exists/i.test(String(e?.message ?? e))) throw e;
        /**
         * DSH 侧还留着同 id 会话（宿主重启、或上一轮崩过之后内存表清空），
         * `agents.create()` 直接报 already exists。2026-11-14 18:53 的
         * `agent.new 400` + `agent.prompt 404` 就是这么来的。
         *
         * 按 aurabot `agentFor()` 的做法复用它：resume 优先（形状与 create
         * 一致），老版本没有就退回 `get()` 拿活 agent 包一层。
         */
        /**
         * 只尽力拿活 agent，拿不到**也不报错**：宿主注入的 `promptFn` 会
         * 自己走 `resolveAgent(sid)`（`ctx.agents.get` →
         * `controller().resolveAgent`），那是宿主里最完整的会话恢复路径。
         *
         * 注意不能靠 `svc.resume(sessionId)`：运行时要的是
         * `{resumeSessionId, agentOptions, ...}`，传字符串会失败（已从
         * app.asar 里核过）。以前这里一拿不到就抛，结果就是 400。
         */
        let live = null;
        if (typeof svc.get === 'function') {
          try { live = await svc.get(sessionId) || await svc.get('session-' + sessionId); } catch { /* 试下一条 */ }
        }
        if (!live && typeof resolveAgentOf === 'function') {
          try { live = await resolveAgentOf(sessionId); } catch (e2) { log?.warn?.(`恢复会话 ${sessionId} 失败：${e2?.message ?? e2}`); }
        }
        handle = live ? { agent: live, dispose: null } : null;
        reused = true;
        if (!live) log?.warn?.(`会话 ${sessionId} 在 DSH 里已存在，暂由 promptFn 自行恢复（${e?.message ?? e}）`);
      }
    }
    const agentCtx = ctxOf(handle);
    if (!agentCtx && !reused) throw new Error('agents.create()/resume() 返回的 handle 上没有会话 ctx');
    /** 复用 `get()` 兜底路径时可能没有 per-agent ctx：跳过注册，但仍让 prompt 走通 */
    if (!agentCtx) log?.warn?.(`复用会话 ${sessionId} 拿不到 agent.ctx，跳过 sections 与指令过滤注册`);
    /**
     * `src/turn.js` 的 `run()` 靠 `agent.session.id ?? agent.sessionId` 认会话，
     * 还要 `ctx.sessions.flush(agent.session)`。多数 DSH 版本的 handle 本来就带，
     * 这里只在缺的时候补一个 id，不覆盖宿主给的值（resume 出来的会话尤其别动）。
     */
    const agent = handle?.agent ?? handle;
    if (agent) {
      if (!agent.session?.id && !agent.sessionId) {
        try { Object.defineProperty(agent, 'sessionId', { value: sessionId, configurable: true }); } catch { /* 只读对象就交给后续报错 */ }
      }
      /** flush(agent.session) 要一个真对象；宿主给了就绝不覆盖（可能带 session- 前缀） */
      if (!agent.session) {
        try { Object.defineProperty(agent, 'session', { value: { id: sessionId }, configurable: true }); } catch { /* 同上 */ }
      }
      if (choice) {
        try {
          if (typeof agent.model?.select === 'function') await agent.model.select(choice);
          else if (typeof agent.session?.append === 'function') agent.session.append('model/selection', choice);
          else if (typeof svc.selectForNextRequest === 'function') svc.selectForNextRequest(agent, choice);
          else log?.warn?.('独立会话没有可用的模型选择入口，第一轮可能报 no provider/model');
        } catch (e) {
          log?.warn?.(`独立会话套用模型失败：${e?.message ?? e}`);
        }
      }
    }

    const offs = [];
    const names = [];
    if (agentCtx) {
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
    }

    // 官方 practices：per-agent 注册要包在 agent.ctx.effect() 里，插件卸载时
    // 才不会把 listener 留在活着的 agent 上。老版本没有 effect 就跳过，靠自己
    // 保存的 disposer 兜底（teardown 会调 dispose()）。
    let effectOff = null;
    if (agentCtx && typeof agentCtx.effect === 'function') {
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
          await promptFn(rec.handle, text, (c) => { chunks.push(c); emit(c); }, { sessionId: rec.sessionId });
          res.write(`event: done\ndata: ${JSON.stringify({ ok: true, chunks: chunks.length })}\n\n`);
          res.end();
          return { streamed: true }; // api-v1 看到 headersSent 会直接 return
        }
        await promptFn(rec.handle, text, (c) => chunks.push(c), { sessionId: rec.sessionId });
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
      await promptFn(rec.handle, String(text ?? ''), (c) => { chunks.push(c); onChunk(c); }, { sessionId });
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
