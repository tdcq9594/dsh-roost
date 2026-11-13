/**
 * 5.7 全链路模拟（dry run）
 * ========================
 *
 * 「假主人 / 假群友发一句，会怎么处理」——把入站到出站的每一层摊开给人看，
 * **一层都不真跑**。和 `dry-run.js`（记忆保留策略预览）是两个东西，只是名字像：
 * 那个算「哪些记忆会被作废」，这个算「这条消息会不会被接、接了会怎么发」。
 *
 * 三条硬约束（写在这里是为了以后别被"顺手优化"掉）：
 *
 *   1. **绝不真发。** 本文件不 import 任何发送路径（`outActions` / `channel` /
 *      `sendOut` / `onInbound` / `fetch`），只 import 三个纯函数模块。真要发，
 *      得先在本文件里加 import——`test/simulate.test.js` 会因为这个变红。
 *   2. **不改运行时状态。** 判定用**新建**的 decider 实例（`createDecider` 的
 *      冷却 / 配额状态在实例里），模拟一次不会影响真链路的下一次判定。
 *   3. **不读盘不写盘。** 配置、工具清单、额度全由调用方喂进来；没喂的层
 *      明确标 `skipped`，不要假装算过（面板上"跳过"比"猜一个"诚实）。
 *
 * 为什么层要固定成 6 层而不是随便拼：面板按 `layer` 分组渲染，用户看的是
 * 「inbound → decide → model → tools → outbound → ledger」这条和真链路同序的
 * 流水线。少一层会让人以为漏了，多一层会让人以为真链路里还有别的步骤。
 */

import { renderInbound, speakerTag, chatOf } from './inbound.js';
import { createDecider } from './roost-decide.js';
import { pickModelFor, pickEffortFor } from './model-pick.js';

/** 层的顺序 = 真链路的顺序，面板直接按这个渲染 */
export const SIM_LAYERS = ['inbound', 'decide', 'model', 'tools', 'outbound', 'ledger'];

export const LAYER_TITLES = {
  inbound: '收到消息',
  decide: '要不要接',
  model: '用哪个模型',
  tools: '能动手的工具有哪些',
  outbound: '会怎么发出去',
  ledger: '投递账本会记什么',
};

/**
 * 面板上「假身份」的预设。
 *
 * `owner` 走私聊（`c2c`）+ 主人档位，`member` 走群聊 + 群友档位。
 * `stranger` 是「群里没 @ 的普通人」——最常被问的那种「为什么她不回我」。
 */
export const SIM_PERSONAS = [
  { id: 'owner', label: '主人（私聊）', kind: 'c2c', bucket: 'owner', name: '主人', mentioned: false },
  { id: 'member', label: '群友（@ 她）', kind: 'group', bucket: 'member', name: '群友', mentioned: true },
  { id: 'stranger', label: '群友（没 @）', kind: 'group', bucket: 'member', name: '群友', mentioned: false },
];

/** 把面板上的选择 + 一句话，拼成一个「像真的」事件 */
export function buildFakeEvent(input = {}) {
  const kind = input.kind === 'c2c' ? 'c2c' : 'group';
  const chatId = String(input.chatId ?? '').trim() || (kind === 'c2c' ? 'sim:c2c' : 'sim:group');
  const name = String(input.name ?? '').trim() || (kind === 'c2c' ? '主人' : '群友');
  const openid = String(input.openid ?? '').trim() || (kind === 'c2c' ? 'SIM_OWNER' : 'SIM_MEMBER');
  const uin = String(input.uin ?? '').replace(/\D/g, '');
  const text = String(input.text ?? '');

  return {
    chat: { chatId, kind, name: String(input.chatName ?? '').trim() || (kind === 'c2c' ? '' : '模拟群') },
    sender: { id: openid, name, uin },
    text,
    mentioned: input.mentioned === true,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    /** 模拟永远不真发，所以带一个假 msgId：真链路里它决定「被动回复、不占主动额度」 */
    msgId: 'SIM_MSG',
  };
}

/** 一个 `ok` 三态：true 过了 / false 被拦 / null 跳过（没数据） */
const step = (layer, ok, reason, detail = null) => ({
  layer,
  title: LAYER_TITLES[layer] || layer,
  ok,
  reason: String(reason ?? ''),
  detail,
});

/**
 * 跑一次模拟。
 *
 * @param {object} o
 * @param {object} o.input   `buildFakeEvent` 的入参（text / kind / mentioned / …）
 * @param {object} o.cfg     当前配置快照（`config.json` 的内容）
 * @param {{pool?:string[], denied?:string[]}} [o.tools]
 *        宿主当前的工具池与被收走的工具名；不给就跳过工具层
 * @param {number} [o.now]   判定用的时间（冷却 / 配额），注入给单测
 * @param {number} [o.random] 0–1，插话概率用，注入给单测
 * @returns {{ok:true, verdict:'reply'|'silent', steps:Array, summary:string,
 *            outbound:object, ledger:object}}
 */
export function simulate({ input = {}, cfg = {}, tools = null, now = Date.now(), random = 0.5 } = {}) {
  const evt = buildFakeEvent(input);
  const steps = [];

  /* ---------- 1. inbound：payload → 给 AI 看的那段话 ---------- */
  const payload = {
    text: evt.text,
    chat: evt.chat,
    sender: evt.sender,
    attachments: evt.attachments,
  };
  const rendered = renderInbound(payload);
  const speaker = speakerTag(payload, evt.chat);
  const chat = chatOf(payload);
  steps.push(step(
    'inbound',
    true,
    evt.text.trim() ? '收到一条文字消息' : '收到一条没有正文的消息',
    { rendered, speaker, chat, mentioned: evt.mentioned },
  ));

  /* ---------- 2. decide：要不要接 ---------- */
  /**
   * 每次模拟都新建一个 decider：冷却 / 配额 / 窗口状态都在实例内部，
   * 复用真链路的实例会让模拟「吃掉」一次真实判定，反过来真链路也会让
   * 模拟结果带上历史状态——两边都不可信。
   */
  const decider = createDecider({ cfg: () => cfg, now: () => Number(now) || Date.now(), random: () => random });
  const verdict = decider.check({
    chat: evt.chat,
    content: evt.text,
    mentioned: evt.mentioned,
    attachments: evt.attachments,
  });
  steps.push(step(
    'decide',
    verdict.go === true,
    verdict.reason,
    {
      force: Boolean(verdict.force),
      cooling: Boolean(verdict.cooling),
      delayMs: Number(verdict.delayMs) || 0,
    },
  ));

  /* ---------- 3. model：用哪个模型、什么思考强度 ---------- */
  const m = cfg?.model ?? {};
  const sel = pickModelFor({
    byChat: m.byChat,
    byKind: m.byKind,
    defaultSel: m.default,
    chatId: evt.chat.chatId,
    kind: evt.chat.kind,
    globalSel: null,
  });
  const effort = pickEffortFor({
    byChat: m.byChat,
    byKind: m.byKind,
    globalEffort: m.effort,
    modelEffort: sel?.reasoningEffort ?? '',
    chatId: evt.chat.chatId,
    kind: evt.chat.kind,
    recommendByKind: m.effortByKind !== false,
  });
  const modelSource = !sel
    ? '没配模型，用 DSH 当前选择'
    : (m.byChat?.[evt.chat.chatId] ? '按这个会话单独配的'
      : (m.byKind?.[evt.chat.kind] ? `按${evt.chat.kind === 'c2c' ? '私聊' : '群聊'}默认`
        : '按全局默认'));
  steps.push(step(
    'model',
    true,
    sel ? `${sel.provider} / ${sel.model}` : '没配模型，用 DSH 当前选择',
    { provider: sel?.provider ?? '', model: sel?.model ?? '', effort, source: modelSource },
  ));

  /* ---------- 4. tools：这一轮能动手的工具 ---------- */
  const pool = Array.isArray(tools?.pool) ? tools.pool.map(String).filter(Boolean) : null;
  const denied = Array.isArray(tools?.denied) ? tools.denied.map(String).filter(Boolean) : [];
  if (!pool) {
    steps.push(step('tools', null, '宿主没给出工具清单，这一步跳过', null));
  } else {
    const deniedSet = new Set(denied);
    const available = pool.filter((n) => !deniedSet.has(n));
    steps.push(step(
      'tools',
      true,
      denied.length ? `能用的 ${available.length} 个，被收走 ${denied.length} 个` : `能用的 ${available.length} 个`,
      { total: pool.length, available, denied },
    ));
  }

  /* ---------- 5. outbound：会怎么发 ---------- */
  /**
   * 只做**形态**预测，不生成内容：内容得模型跑完才有，模拟不跑模型
   * （跑一次要花钱，而且结果不可复现，就不叫模拟了）。
   *
   * 能确定的三件事：
   *   · 有 msgId → 被动回复，不占主动额度（这是 QQ 官方规则）；
   *   · 冷却中 → 会延后 `delayMs`；
   *   · 私聊 / 群里被 @ → 回复会带引用或 @ 回去（由 ai-chat 侧决定，这里只提示）。
   */
  const outbound = {
    willSend: verdict.go === true,
    mode: evt.msgId ? 'passive' : 'active',
    delayMs: Number(verdict.delayMs) || 0,
    scene: evt.chat.kind,
    target: evt.chat.chatId,
    /** 语音 / 表情 / 分段这些要模型输出才知道，这里明确标「取决于模型」 */
    note: verdict.go === true
      ? '会走被动回复（不占主动额度）；具体发几条、发不发语音由模型输出决定'
      : '不会发任何消息',
  };
  steps.push(step('outbound', verdict.go === true, outbound.note, outbound));

  /* ---------- 6. ledger：账本会记什么 ---------- */
  /**
   * 账本由框架侧（bot）写，dsh-roost 只读。所以这里只能给「若真跑会记什么」，
   * 并且**永远**标 `dry: true`——模拟不写盘，账本里不会多出这一条。
   */
  const ledger = {
    dry: true,
    wouldWrite: verdict.go === true,
    entry: verdict.go === true
      ? {
        scene: evt.chat.kind,
        target: evt.chat.chatId,
        mode: outbound.mode,
        text: '（模型输出，模拟不生成）',
      }
      : null,
    note: verdict.go === true
      ? '真跑会记一条投递记录；本次是 dry run，不写账本'
      : '没有出站，账本不会有记录',
  };
  steps.push(step('ledger', verdict.go === true, ledger.note, ledger));

  const willReply = verdict.go === true;
  return {
    ok: true,
    verdict: willReply ? 'reply' : 'silent',
    steps,
    outbound,
    ledger,
    summary: summarize(verdict, evt),
  };
}

/** 一句话结论，面板顶栏用 */
function summarize(verdict, evt) {
  const who = evt.chat.kind === 'c2c' ? '私聊' : '群聊';
  if (verdict.go !== true) return `${who}这句不会回：${verdict.reason}`;
  if (verdict.cooling) return `${who}会回，但要等 ${Math.ceil((Number(verdict.delayMs) || 0) / 1000)} 秒（冷却中，消息攒着）`;
  return `${who}这句会回：${verdict.reason}`;
}

/**
 * 给「复制成文本」用的纯文本版（面板和日志都能贴）。
 * 不用 markdown 表格：贴进 QQ 或 issue 里会散架。
 */
export function formatSimulation(result) {
  if (!result?.steps) return '没有模拟结果';
  const lines = [`【模拟结果】${result.summary}`];
  for (const s of result.steps) {
    const mark = s.ok === true ? '✓' : s.ok === false ? '✗' : '·';
    lines.push(`${mark} ${s.title}：${s.reason}`);
  }
  lines.push('（本次是 dry run，一条消息都没真发）');
  return lines.join('\n');
}
