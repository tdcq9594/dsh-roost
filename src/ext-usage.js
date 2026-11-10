/**
 * 扩展能力面（方案 §3.5 / 实施阶段 2.1 + 2.2）。
 *
 * 三段互不耦合，都只依赖 DSH 官方事件 / API，零外部依赖：
 *   ① QQ 会话 usage section：从清单生成、动态 `text()`、预算截断、`{{...}}` 不插值；
 *   ② 独立 Agent 会话的 instructions 过滤：P2 实测选定的 **B（scope-filtered
 *      `system-prompt/assemble` waterfall）**，只过滤 `mcp:` 前缀 sections，不碰 tools；
 *   ③ 工具输出 4 KB 预算：官方 `tools/post-execute` 的 `PostToolDecision` 内容替换。
 *
 * ⚠️ 本模块只**提供注册函数与可复用纯函数**，不自己挂进运行期。QQ 会话的
 * `mount()` 接线与 disposer 归阶段 3.3 / 5，独立会话的过滤接线归阶段 3.3
 * （§10.1 阶段 3.3「接线 2.1 的过滤模块」）。门 G2 用夹具验这三类组件本身，
 * 完整独立会话验收在 G3 —— 与阶段 1「门只验本阶段组件」的横切铁律一致。
 *
 * 官方形状（从本机 app.asar 源码核对，非推测）：
 *   · `system-prompt/assemble` listener = `(asm, context, next) => Promise<assembly>`，
 *     `next()` 返回 `{ sections, contexts, variables, tools }`（P2 探针 probe4.mjs 11/11）。
 *   · `tools/post-execute` listener = `(exec, result, next) => Promise<PostToolDecision>`，
 *     `next()` 默认返回 `{ kind:'accept' }`；`decision.content ?? result.content`；
 *     `kind:'block'` 与显式 `value` 替换必须原样放行（dsh-tools/lib/types/pipeline.js、
 *     dsh-spill-policy/lib/index.js）。
 */

/** `order` 的暂定回退值。官方可用时一律走 `getSectionOrder('MCP_SERVERS')`，见 §3.5 ① 的警告。 */
export const USAGE_ORDER_FALLBACK = 950;
/** 单条 usage section 的字数上限（按 Unicode 码点，中文按「字」算）。 */
export const USAGE_CHAR_LIMIT = 200;
/** 所有 usage section 合计的 UTF-8 字节上限。 */
export const USAGE_TOTAL_BYTE_LIMIT = 2048;
/** 单次工具返回的 UTF-8 字节上限（内容替换，不是数据量硬闸）。 */
export const TOOL_OUTPUT_BYTE_LIMIT = 4096;

const USAGE_MARK = '…（已截断）';
const OUTPUT_MARK = '…（工具输出已截断，仅保留前 4 KB）';

const bytesOf = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/** 按码点截字，不切断 surrogate pair。 */
export function truncateChars(raw, max = USAGE_CHAR_LIMIT) {
  const chars = Array.from(String(raw ?? ''));
  if (chars.length <= max) return { text: chars.join(''), truncated: false };
  return { text: chars.slice(0, max).join(''), truncated: true };
}

/** 按 UTF-8 字节截字：一个字要么全留、要么不留，绝不产生半个字符。 */
function takeBytes(raw, budget) {
  let out = '';
  let used = 0;
  for (const ch of Array.from(String(raw ?? ''))) {
    const n = bytesOf(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out;
}

export function usageSectionName(id) {
  return `ext:${id}:usage`;
}

/** 清单文本按字面进 text：这里绝不做任何 `{{...}}` 模板替换。 */
export function usageText({ id, usage }) {
  return `【扩展：${id}】${usage ?? ''}（工具：mcp__${id}__*）`;
}

/**
 * 生成 usage section 描述数组。
 *
 * `text` 必须是**函数**：每次 assembly 重新求值，面板改 usage 后下一个请求
 * 就生效（§3.5 ①，参考 dsh-persona-dafeiyu）。函数只读 registry 的内存
 * usageCache（零 IO）；预算也每次重算，所以改长的 usage 不会绕过 2 KB 上限。
 * N 个 section 各自调一次 render，纯内存计算，无文件 / 网络访问。
 */
export function createUsageSections(registry, opts = {}) {
  const {
    charLimit = USAGE_CHAR_LIMIT,
    totalBytes = USAGE_TOTAL_BYTE_LIMIT,
    order = USAGE_ORDER_FALLBACK,
    log = () => {},
  } = opts;

  if (!registry || typeof registry.list !== 'function' || typeof registry.liveUsage !== 'function') {
    throw new Error('createUsageSections 需要带 list()/liveUsage() 的 registry');
  }
  // 安装 / 卸载会整组撤销并重新 mount（§3.5 ①），所以 id 列表在 mount 时固定一次。
  const ids = registry.list().map((x) => x.id);
  let lastWarn = '';

  function render() {
    const byId = new Map();
    const truncated = [];
    let used = 0;
    const markBytes = bytesOf(USAGE_MARK);

    for (const id of ids) {
      const one = truncateChars(usageText({ id, usage: registry.liveUsage(id) }), charLimit);
      if (one.truncated) truncated.push({ id, why: `单条 ${charLimit} 字` });

      let text = one.text;
      // 每条都预留标注字节是保守做法：保证「本条触发合计截断」时永远放得下标记，
      // 代价是未被截的条也各让出约 18 字节，预算利用率略低但不会越界。
      const room = totalBytes - used - markBytes;
      if (room <= 0) {
        // 空串会被官方 renderPrompt 的空文本 filter 丢掉 = 整段消失，不是
        // 「带标注的截断」。工具表仍由 provider 独立贡献，功能不受影响（§3.5）。
        byId.set(id, '');
        truncated.push({ id, why: '合计预算耗尽' });
        continue;
      }
      if (bytesOf(text) > room) {
        text = takeBytes(text, room) + USAGE_MARK;
        truncated.push({ id, why: '合计 2 KB' });
      }
      used += bytesOf(text);
      byId.set(id, text);
    }

    const sig = truncated.map((x) => `${x.id}:${x.why}`).join('|');
    if (sig && sig !== lastWarn) {
      lastWarn = sig;
      log.warn?.(`usage 已截断：${truncated.map((x) => `${x.id}（${x.why}）`).join('、')}`);
    }
    return { byId, bytes: used, truncated };
  }

  const sections = ids.map((id) => ({
    name: usageSectionName(id),
    order,
    interpolate: false,
    text: () => render().byId.get(id) ?? '',
  }));

  return { ids, sections, render };
}

/** 官方可用时取官方分配值；取不到才回退 950，并明确记 warn（方案不让把 950 当已验证契约）。 */
export function resolveUsageOrder(systemPrompt, log = () => {}) {
  const n = systemPrompt?.getSectionOrder?.('MCP_SERVERS');
  if (Number.isFinite(n)) return n;
  log.warn?.(`getSectionOrder('MCP_SERVERS') 不可用，usage section 回退 order=${USAGE_ORDER_FALLBACK}（非契约值）`);
  return USAGE_ORDER_FALLBACK;
}

/**
 * Cordis 的 disposer 可能是函数，也可能是带 dispose() 的 effect 对象。
 * 单个 disposer 抛错不能中断整组撤销 —— 否则后面没撤的 listener 会静默
 * 残留在活着的 agent 上（§11 坑 3）。
 */
export async function invokeDisposer(off, log = () => {}) {
  if (!off) return;
  try {
    if (typeof off === 'function') return await off();
    if (typeof off.dispose === 'function') return await off.dispose();
  } catch (e) {
    log.warn?.(`disposer 撤销失败（已跳过）：${e?.message ?? e}`);
  }
}

async function groupDispose(offs) {
  // 后注册的先撤，和「注册顺序反过来」的常规 teardown 一致。
  for (const off of [...offs].reverse()) await invokeDisposer(off);
}

/**
 * ② 独立会话 instructions 过滤 —— **B：scoped waterfall**。
 *
 * 必须注册在**该会话的 `agent.ctx`**（Scope-filtered dispatch 保证只收到这个
 * scope 的 assembly，QQ 会话根本不进这个 listener）。只过滤 `mcp:` 前缀，
 * `tools` 与其它字段一律 spread 保留；不注册任何 `complete` section
 * （`complete:true` 会把人格 / 记忆全砍掉，§3.5 ③ 明确否决）。
 *
 * ⚠️ **给阶段 3.3 接线的契约**：官方 practices 要求把 per-agent 注册包在
 * `agent.ctx.effect()` 里，并把 disposer **按 agent 分桶**留在宿主自己的 effect
 * 中 —— 插件卸载 / HMR 不会替你 dispose `agent.ctx` 上的注册。本模块只负责
 * 返回 disposer；3.3 接线时必须补这层，且 `createExtUsage()` 的 `offs` 要按
 * agent key 分桶才能单独关一个会话（当前聚合是统一撤销，阶段 2 只有一个夹具会话）。
 */
export function mountInstructionFilter(agentCtx, { prefix = 'mcp:', log = () => {} } = {}) {
  if (!agentCtx || typeof agentCtx.on !== 'function') {
    throw new Error('instructions 过滤必须注册在带 on() 的会话 agent.ctx 上');
  }
  const off = agentCtx.on('system-prompt/assemble', async (_asm, _context, next) => {
    const out = await next();
    if (!out || !Array.isArray(out.sections)) return out;
    const before = out.sections.length;
    const sections = out.sections.filter((s) => !String(s?.name ?? '').startsWith(prefix));
    const removed = before - sections.length;
    if (removed) log.info?.(`独立会话已过滤 ${removed} 条第三方 instructions section`);
    return { ...out, sections };
  });
  return () => invokeDisposer(off);
}

/**
 * ① QQ 会话 usage section 注册。关扩展 / 卸载 / 关会话时调用返回的 disposer
 * 整组撤销（§3.5 ①）。这里**不**给独立会话注册 usage（§9-#19 的既有决策）。
 */
export function mountUsageSections(agentCtx, registry, opts = {}) {
  if (!agentCtx) throw new Error('mountUsageSections 需要会话 agent.ctx');
  const sp = agentCtx.systemPrompt ?? agentCtx.get?.('systemPrompt') ?? null;
  if (!sp || typeof sp.section !== 'function') {
    throw new Error('会话 ctx 上没有可用的 systemPrompt.section()');
  }
  const { log = () => {}, ...rest } = opts;
  const order = resolveUsageOrder(sp, log);
  const { sections, render } = createUsageSections(registry, { ...rest, order, log });
  const offs = sections.map((s) => sp.section(s));
  return { names: sections.map((s) => s.name), sections, offs, render, dispose: () => groupDispose(offs) };
}

/**
 * ③ 2.2 工具输出 4 KB 预算的**纯函数**。
 *
 * 只改「结果进模型前」的 content 数组：文字按 UTF-8 字节截；超限后剩下的块
 * （含图片）一律丢掉 —— 二进制块没法按字节截半张图，留着就等于没闸。
 * 末尾追加标注文字，且标注本身算进预算，保证返回值总字节不超过 limit。
 * ⚠️ 这是内容替换，不影响扩展实际产生的数据量与网络往返（§13）。
 */
export function truncateToolContent(content, limit = TOOL_OUTPUT_BYTE_LIMIT) {
  if (!Array.isArray(content)) return { content, truncated: false, originalBytes: 0, keptBytes: 0 };
  /**
   * 非文本块没有统一的「内容字节」字段（图片可能是 data / source.data / url…），
   * 用整块 JSON 的 UTF-8 长度做保守估算。**不能只统计 text 块**：截图类工具
   * 返回一张 20 KB 的 base64 大图时，只算文字会得到 0 字节、预算静默失效。
   */
  const blockBytes = (b) => {
    if (b?.type === 'text') return bytesOf(b.text);
    try { return bytesOf(JSON.stringify(b ?? '')); } catch { return limit; }
    // 循环引用 / BigInt 之类不可序列化的块估不出来 → 直接按「已达上限」算，
    // 宁可保守截断也不让一个估不出的块静默绕过预算（fail-closed）。
  };
  const originalBytes = content.reduce((n, b) => n + blockBytes(b), 0);
  if (originalBytes <= limit) {
    // 未截断时 originalBytes / keptBytes 含非文本块的 JSON 结构估算开销，
    // 只用于统计与日志；调用方请据 `truncated` 判断是否发生了内容替换。
    return { content, truncated: false, originalBytes, keptBytes: originalBytes };
  }
  const budget = limit - bytesOf(OUTPUT_MARK);
  if (budget <= 0) {
    // 预算连标注都放不下：宁可原样放行，也不产出一个空结果骗模型。
    return { content, truncated: false, originalBytes, keptBytes: originalBytes };
  }
  const out = [];
  let used = 0;
  for (const block of content) {
    if (used >= budget) break;
    if (block?.type !== 'text') continue;
    const raw = String(block.text ?? '');
    if (bytesOf(raw) <= budget - used) {
      out.push({ ...block, text: raw });
      used += bytesOf(raw);
    } else {
      const kept = takeBytes(raw, budget - used);
      out.push({ ...block, text: kept });
      used += bytesOf(kept);
    }
  }
  out.push({ type: 'text', text: OUTPUT_MARK });
  return { content: out, truncated: true, originalBytes, keptBytes: used + bytesOf(OUTPUT_MARK) };
}

/** ③ 注册官方 `tools/post-execute` waterfall。返回 disposer。 */
export function mountToolOutputBudget(ctx, { limit = TOOL_OUTPUT_BYTE_LIMIT, log = () => {} } = {}) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('工具输出预算需要带 on() 的 ctx');
  const off = ctx.on('tools/post-execute', async (_exec, result, next) => {
    const decision = await next();
    // 官方约定：不拥有决策就原样放行。block / 已有 value 替换都是别的 listener
    // 的权威结果，覆盖它们会把别人的 veto 或值替换悄悄吃掉。
    // 因此预算只在「默认 accept 且无 value」的结果上生效；若上游恒定产出
    // value，这条链路不生效（官方 spill-policy 语义），G3 真机需确认无此上游。
    if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
    const content = decision.content ?? result?.content;
    const cut = truncateToolContent(content, limit);
    if (!cut.truncated) return decision;
    log.info?.(`工具输出已截断：${cut.originalBytes} → ${cut.keptBytes} 字节（上限 ${limit}）`);
    // spread 保留 additionalContexts / feedback 等其它字段（官方 practices 明确要求）。
    return { ...decision, content: cut.content };
  });
  return () => invokeDisposer(off);
}

/**
 * 聚合入口，**只适合单会话夹具 / 一次性脚本**。
 *
 * ⚠️ 多 agent 运行期不要用：这里的 `offs` 是单个 Set，关掉一个会话后条目
 * 仍在、也无法单独撤销。host.js 运行期直接调本文件的三个 `mount*()`，
 * 各自把 disposer 交给 `mount()` 的 offs / `rec.offs` / `mountOffs`，
 * 撤销路径唯一（阶段 3.3 复核后定稿）。
 */
export function createExtUsage({ registry, log = () => {} } = {}) {
  const offs = new Set();
  const track = (off) => { if (off) offs.add(off); return off; };

  return {
    /** QQ 会话：注册 usage，返回带 dispose() 的句柄。 */
    mountUsage: (agentCtx, opts = {}) => track(mountUsageSections(agentCtx, registry, { ...opts, log })),
    /** 独立会话：注册 B 过滤，返回带 dispose() 的句柄。 */
    mountFilter: (agentCtx, opts = {}) => track(mountInstructionFilter(agentCtx, { ...opts, log })),
    /** 工具输出预算：注册在宿主 ctx 上即可（waterfall 自己按 exec.agent 分 scope）。 */
    mountOutputBudget: (ctx, opts = {}) => track(mountToolOutputBudget(ctx, { ...opts, log })),
    dispose: () => groupDispose([...offs]),
  };
}
