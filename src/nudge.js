/**
 * 她问了一句、主人没回 → 偶尔轻轻追一句（A2）——移植自 aurabot-beta 的 maybeNudge 判据。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见
 * THIRD-PARTY-NOTICES.md。
 *
 * **同名不同物**：我方 speakup.js 的「追问只一次」是刹车（上次主动说了没被理就不再追），
 * 这里是「她问了主人一句、15–40 分钟没回、追一句人呢」——两件事，别混。
 *
 * 纯函数：判据与标记状态可单测；会话注入/抽空由调用方执行。
 */

import { readJson, writeJson } from './autotelic-store.js';

const MINUTE = 60_000;
export const NUDGE_MIN_MS = 15 * MINUTE;
export const NUDGE_MAX_MS = 40 * MINUTE;

/**
 * 判定一条 bot→owner 消息是否构成「该追一句」。
 * @param {object} o
 * @param {object} o.lastBot 对方最后发给主人的 {at, text}
 * @param {number} o.lastOwnerAt 主人最后说话时刻
 * @param {number} o.now
 * @param {number} o.nudgedFor 已经追过的那条 bot 消息时刻（0 = 没追过）
 * @param {object} o.gates {masterOn, speakUpOn, nudgeOn, inQuiet, dailyMax, countToday, cooling}
 * @returns {{yes:boolean, why:string}}
 */
export function judgeNudge({ lastBot = {}, lastOwnerAt = 0, now = Date.now(), nudgedFor = 0, gates = {} } = {}) {
  if (!gates.masterOn || !gates.speakUpOn || !gates.nudgeOn) return { yes: false, why: '总开关/主动搭话/追问没全开' };
  const at = Number(lastBot?.at) || 0;
  if (!at || at <= Number(lastOwnerAt) || 0) return { yes: false, why: '主人后来回过了，或没有可追的消息' };
  if (nudgedFor && Number(nudgedFor) === at) return { yes: false, why: '这条消息追过了' };
  const text = String(lastBot?.text || '').trim();
  /** 问号在哪儿都算；吗/呢/嘛/没必须锚句尾——陈述句里的「嘛」不算提问 */
  if (!/[？?]|(?:吗|呢|嘛|没)$/.test(text)) return { yes: false, why: '最后一句不是提问' };
  const quiet = Number(now) - at;
  if (!(quiet > NUDGE_MIN_MS && quiet < NUDGE_MAX_MS)) return { yes: false, why: '不在 15–40 分钟窗口' };
  if (gates.inQuiet) return { yes: false, why: '安静时段不打扰' };
  if (Number(gates.dailyMax) > 0 && Number(gates.countToday) >= Number(gates.dailyMax)) return { yes: false, why: '今天到上限了' };
  if (gates.cooling) return { yes: false, why: '系统会话冷却中' };
  return { yes: true, why: `她 ${Math.round(quiet / MINUTE)} 分钟前问了句，追一句` };
}

/**
 * 追问标记存储（单独文件，不进会被 normalize 洗字段的状态文件）。
 * 关键口径：**真决定要发了才写标记**——抽空/让位时不写，这条消息还能再追一次。
 */
export function createNudgeStore({ file = '' } = {}) {
  const load = () => (file ? readJson(file, {}) : {});
  const nudgedFor = () => Number(load()?.nudgedFor) || 0;
  const mark = (at) => { if (file) writeJson(file, { ...load(), nudgedFor: Number(at) || 0 }); };
  /** 只有「这一轮根本没发生」（busy/提交失败）才回滚；超时按已追过处理，防双发。
   *  且只在 nudgedFor 仍是这一条时回滚，别把后来已追的新句一起抹掉。 */
  const rollbackIfNotHappened = (at, reason) => {
    const s = load();
    if (['busy', 'submit-failed', 'unsupported-chat'].includes(String(reason))
      && Number(s.nudgedFor) === Number(at)) {
      if (file) writeJson(file, { ...s, nudgedFor: 0 });
    }
  };
  /**
   * 「她最后跟主人说了什么」——**独立于老 speakUp 引擎**。
   * 对方 hub.js:2114 在所有真私聊投递后记 lastBotToOwner；我方老引擎关着时
   * speakUp.state().lastBotAt 恒 0，nudge 永不触发，所以必须自己记。
   * 只在真送达（非 pending / 非 dryRun）时记——没送出口的话不算「她说过」。
   */
  const lastBot = () => {
    const s = load();
    return { at: Number(s.botAt) || 0, text: String(s.botText || '') };
  };
  const recordBot = (text, at = Date.now()) => {
    if (file) writeJson(file, { ...load(), botAt: Number(at), botText: String(text || '').slice(0, 300) });
  };
  /** 主人最后私聊发话（对方 lastOwnerChatAt）；后来回过就不追 */
  const lastOwnerAt = () => Number(load()?.ownerAt) || 0;
  const recordOwner = (at = Date.now()) => {
    if (file) writeJson(file, { ...load(), ownerAt: Number(at) });
  };
  /** 失败退避：下次最早可试时刻（对方 systemSessionCooldown） */
  const cooling = (at = Date.now()) => Number(load()?.coolUntil) > Number(at);
  const markCool = (minutes, at = Date.now()) => {
    if (file) writeJson(file, { ...load(), coolUntil: Number(at) + Number(minutes) * MINUTE });
  };
  return { load, nudgedFor, mark, rollbackIfNotHappened, lastBot, recordBot, lastOwnerAt, recordOwner, cooling, markCool };
}

/** 追问提示词：真实静默分钟数只有一个来源，不许模型拿别的时长叠加 */
export function nudgePrompt({ text, quietMs, owner = '主人', recentLines = [] } = {}) {
  const idle = Math.round(Number(quietMs) / MINUTE);
  const recentBlock = recentLines.length
    ? `\n【${owner}最近真的对你说过的话（真实聊天记录，越靠后越新）】\n${recentLines.map((s) => `${owner}：${String(s).slice(0, 80)}`).join('\n')}\n`
    : '';
  return [
    `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(text || '').slice(-60)}」，到现在 ${idle} 分钟没有回你。`,
    recentBlock,
    `这一轮不能用工具，直接输出你要发的那句话。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 <<skip>>。`,
    `注意：${idle} 分钟就是${owner}没回你的真实时长。不要用任何其它来源的「过了多久」来替代或叠加它，也不要把它说成更大的数。`,
  ].filter(Boolean).join('\n');
}
