/**
 * QQ 动作工具：把「发言」从**模型吐文本**变成**模型自己调工具**。
 *
 * 为什么值得改（抄的是 SurfCore 的 `reserved2` 模式，MIT）：
 *
 *   改造前的链路是「模型输出一整段 → 宿主 postReply → ai-chat 按长度切段发」。
 *   模型对这一轮**没有任何控制权**：它不能决定"分两句说"、
 *   不能说一半停下看看对方反应、也不能说完就明确退场。
 *
 *   改成工具之后：
 *     · `qq_send` 调一次 = 一段话。调几次由它自己定（上限 3 段）
 *     · `qq_close` = 明确收尾，不用再在正文里夹 `<<close:>>` 标记
 *     · 两者都不调 = 这一轮不说话（真正的"看了但不接"）
 *
 * 为什么不走主动发送接口（`channels.active().send`）：
 *   那是**主动消息**，私聊有 20 条/分、群里还要 `group_push` 授权，
 *   而我们正处在「对方刚说完话」的被动窗口里，用主动接口既浪费配额
 *   又可能被官方拒。所以这里走 `postReply(..., done:false)` ——
 *   同一个事件的多段回话，ai-chat 那边原生支持（`bridge.js` 的 `MAX_PARTS`）。
 *
 * **调几次就发几条**：`qq_send` 每调一次是一段，ai-chat 那边拿到的是
 * `parts` 数组（`bridge.js` 的 `MAX_PARTS`），会**逐条 `replyNow` 发出去**，
 * 不是拼成一段。这条链路 2026-10 改的，改之前多段会被 `planChunks` 合并
 * （它只在超过 1800 字时才切），"分两句说"等于没分。
 *
 * 上限对齐官方硬限制：同一条消息最多被动回复 5 次（`msg_seq` 1–5），
 * 所以 ai-chat 侧 `MAX_SEGMENTS` 也是 5，这里默认 3 是留余量。
 */

import { loadDefineTool } from './tools.js';
import { acceptClose } from './closing.js';

/** 单轮最多发几段。QQ 被动回复同一条消息只让回 5 次（msg_seq 1–5），留余量 */
export const MAX_PARTS = 3;

/**
 * 拼工具定义。抽成纯函数是为了能单测——
 * 次数上限和「群聊不能收尾」这类判断写错，表现是刷屏或者群里莫名退场，
 * 都是只能靠线上观察才会发现的那种错。
 *
 * @param {object} o
 * @param {() => {chatId:string, kind:string, said:string, hasPayload:boolean, bucket:string}} o.callerOf
 *        当前这一轮是谁、在哪儿说（每轮变，所以必须是函数）
 * @param {(text:string)=>Promise<{ok:boolean, message?:string}>} o.sendOf
 * @param {(r:{chatId:string, point:string, resume:string, kind:string})=>{ok:boolean, why:string}} o.closeOf
 * @param {() => object} o.cfgOf
 * @param {() => {parts:number}} o.stateOf 本轮已发段数
 */
export function buildQqToolDefs({ callerOf, sendOf, closeOf, cfgOf, stateOf }) {
  const caller = () => callerOf?.() || { chatId: '', kind: '', said: '', hasPayload: false, bucket: '' };
  const maxParts = () => {
    const n = Number(cfgOf?.()?.qqTools?.maxParts);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : MAX_PARTS;
  };

  const send = {
    name: 'qq_send',
    description:
      '把一段话发出去。想分两句说就调两次（每次一段），想只回一句就调一次。'
      + `一轮最多 ${maxParts()} 段，调多了会被拒。`
      + '**调过这个工具之后，回复正文就不会再自动发出去了**（正文只当思考用）——'
      + '所以要么调工具、要么直接写正文，别两边都写。不想说话就一次都别调。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发出去的话。口语、简短；一段一个意思，别把两件事塞进一段',
        },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object' },
      /** 必须是内容块数组——字符串会让 DSH 的 content.some 炸掉（0.9.x 的真实事故） */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ text } = {}) {
      const t = String(text ?? '').trim();
      if (!t) return { ok: false, message: '要说什么？' };
      const c = caller();
      if (!c.hasPayload) return { ok: false, message: '这一轮没有可回话的消息（不该发生，记一下）' };

      const st = stateOf?.() || { parts: 0 };
      if (st.parts >= maxParts()) {
        return {
          ok: false,
          message: `这一轮已经发了 ${st.parts} 段，上限 ${maxParts()} 段。剩下的并进上一段，或者别说了。`,
        };
      }

      try {
        const r = await sendOf(t);
        if (!r?.ok) return { ok: false, message: r?.message || '没发出去' };
        return { ok: true, part: st.parts + 1, note: '发出去了，正文不用再写一遍' };
      } catch (e) {
        return { ok: false, message: `发送失败：${e?.message ?? e}` };
      }
    },
  };

  const close = {
    name: 'qq_close',
    description:
      '给这段对话收个尾：记一句「收在哪、下次怎么接」，**不发言、不动记忆**。'
      + '对方说要睡了/要出门、或者话题自然聊完了的时候用。'
      + '**对方还在问你问题时不要用**；只有私聊能用。'
      + '收尾之后这一轮可以什么都不发。',
    parameters: {
      type: 'object',
      properties: {
        point: { type: 'string', description: '这段聊到哪儿停的，一句话' },
        resume: { type: 'string', description: '下次可以怎么接，一句话（可省）' },
      },
      required: ['point'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ point, resume } = {}) {
      const c = caller();
      /**
       * 三条拒绝跟标记那条路**共用同一个函数**（`acceptClose`）。
       *
       * 为什么不让工具和标记各判一套：两条路各写一份判断，
       * 迟早会出现「标记收尾被拒、工具收尾却成功」这种事，
       * 而用户只会觉得"她有时候讲道理有时候不讲"。
       */
      const gate = acceptClose({ point, kind: c.kind, said: c.said });
      if (!gate.ok) return { ok: false, message: gate.why };

      try {
        const r = closeOf({
          chatId: c.chatId,
          point: String(point).trim(),
          resume: String(resume ?? '').trim(),
          kind: c.kind,
        });
        if (!r?.ok) return { ok: false, message: r?.why || '没记上' };
        return { ok: true, message: '收尾记下了。这一轮可以不说话，也可以只说一句。' };
      } catch (e) {
        return { ok: false, message: `收尾失败：${e?.message ?? e}` };
      }
    },
  };

  return [send, close];
}

/**
 * 把 QQ 动作工具挂到一个 agent 上。
 *
 * 失败**不抛错**——工具是增强，装不上不能让整轮对话挂掉；但必须把原因带出去
 * （面板要能看见"没装上"，静默失败等于死代码）。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerQqTools({ agent, callerOf, sendOf, closeOf, cfgOf, stateOf, log = () => {} }) {
  const defs = buildQqToolDefs({ callerOf, sendOf, closeOf, cfgOf, stateOf });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    /**
     * 同 tools.js：用 **agent 的** ctx，不是插件的 ctx。
     * 插件的 `inject` 里千万别加 `'tools'`——声明不存在的服务会让整个插件激活失败。
     */
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }

  const defineTool = await loadDefineTool();
  const made = [];

  for (const def of defs) {
    try {
      const tool = defineTool ? defineTool(def) : def;
      const off = registry.register(tool);
      made.push({ off, name: def.name });
    } catch (e) {
      log(`QQ 工具 ${def.name} 没装上：${e.message}`);
      return {
        ok: false,
        names: made.map((m) => m.name),
        reason: `${def.name} 注册失败：${e.message}${defineTool ? '' : '（拿不到 @deepseek-ai/dsh-tools，交的是普通对象）'}`,
      };
    }
  }

  return {
    ok: true,
    names: made.map((m) => m.name),
    mode: defineTool ? 'defineTool' : 'plain',
    off: () => {
      for (const m of made) {
        try {
          m.off?.();
        } catch {}
      }
    },
  };
}
