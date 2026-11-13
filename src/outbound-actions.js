/**
 * 出站动作层：把模型写的标记变成「干净正文 + 可执行动作」。
 * ==========================================================
 *
 * 移除 ai-chat 之前，这一层在插件里（`decide.js:parseActions` +
 * `outbound.js:sendMedia`）：宿主 `applyMemoryMarkers` 只处理记忆类标记，
 * 把 image / voice / say / button / silence 原样放行给 ai-chat 执行。
 * 直连之后没有下游了，`markers.js` 又还在放行 ⇒ 标记会原样进群。
 *
 * 这里补上同一个分界线，但不改上游 `applyMemoryMarkers` 的行为：
 * 它照旧只摘记忆类，本模块在**真正发送前**再摘一次动作类，然后执行。
 * 所有出站路径（主回复 / `qq_send` 分段直发 / `/v1/message` 扩展投递）
 * 都经过 `deliverBatch` 的 `send()`，一处收口不会漏。
 *
 * 设计上刻意对齐旧 ai-chat 的语义，保证「原有体验不变」：
 *   · `<<image: 路径>>`      就地插图 → 上传 Markdown 素材，换成 `![](qqbot-media://…)`
 *   · `<<image-alone: 路径>>` 单独发一条图（正文先发、图后发）
 *   · `<<voice: 路径>>`      单独发一条语音
 *   · `<<say: 文本>>`        宿主 TTS 合成后发语音条（没开语音就静默跳过）
 *   · `<<button: 标签|指令>>` 挂到本条 Markdown 的 keyboard
 *   · `<<silence: 2h>>`      走框架闸 `gate.silence`
 *   · `<<retract>>`          撤回这一轮之前自己发的最后一条
 *   · `<skip>`               永不外发；正文只剩它时不发这条消息
 *   · 代码块 / 行内代码里的标记不执行（模型讲解写法时不会误发图）
 *
 * 路径只做「形状」判据，不做存在性检查——存在性归框架（它才知道文件在
 * 哪台机器上）。**任何上传失败都把占位符换成空串**，绝不把本地绝对路径
 * 以 `![](C:\…)` 的形式发进群。
 */

import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i;
const VOICE_EXT = /\.(silk|amr|mp3|wav|ogg|m4a)(?:[?#].*)?$/i;
const SOURCE_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\|\/|[a-z]:[\\/]|\.{1,2}[\\/])/i;

/** 单轮最多发几个独立媒体，和旧 ai-chat 的 MAX_MEDIA 一致 */
export const MAX_MEDIA = 3;
/** 同一轮里多段直发可能重复带同一个标记，按 type+value 去重 */
const DEDUPE_MS = 60_000;

export function codeRanges(text) {
  const s = String(text ?? '');
  const ranges = [];
  const fence = /^[ \t]*(`{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of s.matchAll(fence)) ranges.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(/`[^`\n]+`/g)) {
    const at = m.index ?? 0;
    if (ranges.some(([a, b]) => at >= a && at < b)) continue;
    ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

const inCode = (at, ranges) => ranges.some(([a, b]) => at >= a && at < b);

/** 值像不像真能拿去的地址（模型举例时会写「图片路径」这种占位词） */
export function looksLikeSource(p) {
  const s = String(p ?? '').trim();
  return Boolean(s) && (SOURCE_PREFIX.test(s) || IMAGE_EXT.test(s));
}

/** `file:///C:/…` 还原成本地路径；其它协议原样不动 */
export function normalizeSource(p) {
  const s = String(p ?? '').trim();
  if (!/^file:\/\//i.test(s)) return s;
  try {
    return decodeURIComponent(new URL(s).pathname.replace(/^\/([a-z]):/i, '$1:'));
  } catch {
    return s;
  }
}

/** `<<silence:2h>>`：默认单位是分钟，上限 30 天（与旧实现一致） */
export function parseDurationMs(v) {
  const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return 0;
  const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'm').toLowerCase()];
  return Math.min(Math.round(Number(m[1]) * mul), 30 * 86_400_000);
}

/** `<<button: 标签|指令>>`，最多 4 个、每行 2 个 */
export function parseButton(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*[|｜]\s*/);
  const label = String(parts[0] ?? '').trim().slice(0, 12);
  const data = String(parts[1] ?? label).trim().slice(0, 100);
  return label ? { label, data } : null;
}

/**
 * `<<button: 标签|指令>>`，最多 4 个、每行 2 个。
 *
 * **形状必须是 `{ content: { rows } }`**，不是 `{ rows }`。
 *
 * 官方把按钮挂在 Markdown 消息的 `keyboard` 字段上，这个字段是二选一：
 * `{ "id": "模板 id" }` 或者 `{ "content": { "rows": [...] } }`（自定义按钮）。
 * 少包一层 `content` 的时候腾讯不会报错，**只会把整个 keyboard 当没看见**——
 * 消息正常发出去、图也在、就是没有按钮，日志里一个字都不留（2026-11-13 实机：
 * 「按钮怎么没了」）。同仓 `bot/src/message.js` 的 `replyCard` 注释里写的就是
 * `keyboard: { content: { rows: [...] } }`。
 */
export function buildKeyboard(buttons, { max = 4, perRow = 2 } = {}) {
  const list = (buttons ?? []).filter((b) => b && b.label).slice(0, max);
  if (!list.length) return null;
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push({
      buttons: list.slice(i, i + perRow).map((b, j) => ({
        id: String(i + j + 1),
        render_data: { label: b.label, visited_label: b.label, style: 1 },
        action: { type: 2, permission: { type: 2 }, data: b.data },
      })),
    });
  }
  return { content: { rows } };
}

/**
 * 解析正文里的动作标记。
 *
 * @returns {{text:string, actions:Array<{type:string,value?:string}>, wantSkip:boolean}}
 */
export function parseOutboundActions(raw) {
  const actions = [];
  let out = String(raw ?? '');

  /** `<skip>` 先摘：它影响「这条要不要发」，不是动作 */
  const wantSkip = /<skip>/i.test(out);
  if (wantSkip) out = out.replace(/<skip>/gi, '');

  const take = (re, type, hasValue = true) => {
    const ranges = codeRanges(out);
    out = out.replace(re, (...args) => {
      const offset = args[args.length - 2];
      if (typeof offset === 'number' && inCode(offset, ranges)) return args[0];
      actions.push(hasValue ? { type, value: String(args[1] ?? '').trim() } : { type });
      return '';
    });
  };

  take(/<<retract>>/gi, 'retract', false);
  take(/<<silence[:：]\s*([\s\S]*?)>>/gi, 'silence');
  take(/<<button[:：]\s*([\s\S]*?)>>/gi, 'button');
  take(/<<say[:：]\s*([\s\S]*?)>>/gi, 'say');
  take(/<<voice[:：]\s*([\s\S]*?)>>/gi, 'voice');

  /** `<<image-alone: 路径>>`：单图单独发；值不像路径就只摘掉，别把占位词留群里 */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<image-alone[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      const p = normalizeSource(String(v ?? '').trim());
      if (looksLikeSource(p)) actions.push({ type: 'imageAlone', value: p });
      return '';
    });
  }

  /**
   * `<<image: 路径>>`：就地插图。先换成不含路径的占位符，等上传成功再填
   * `qqbot-media://`。**不能先写成 `![](C:\…)`**——上传失败时那串会原样进群。
   */
  {
    const ranges = codeRanges(out);
    let n = 0;
    out = out.replace(/<<image[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      const p = normalizeSource(String(v ?? '').trim());
      if (!looksLikeSource(p)) return '';
      const key = `\u0001IMG${n++}\u0001`;
      actions.push({ type: 'inlineImage', value: p, key });
      return key;
    });
  }

  /** `<<file:>>` 只摘不执行：发文件必须走 `qq_send_file` 工具 */
  take(/<<file[:：]\s*([\s\S]*?)>>/gi, 'file');

  /** 兜底：剩下的已知/未知 `<<名字>>` 全摘（代码块里的不动） */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<[a-z][a-z-]{0,20}(?:[:：][^<>]{0,2000})?>>/gi, (m, offset) => {
      if (typeof offset === 'number' && inCode(offset, ranges)) return m;
      return '';
    });
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, actions, wantSkip };
}

/**
 * 执行器。持有「每个会话自己发的最后一条」与媒体去重表，跨轮有效。
 *
 * @param {object} o
 * @param {() => object} o.channel   取当前通道（延迟取，热切换通道不会拿到旧的）
 * @param {object} [o.tts]          `createTts()` 实例，给 `<<say>>` 用
 * @param {object} [o.quota]        `createQuota()` 实例，给 `<<say>>` 扣「语音条」额度
 * @param {(m:string)=>void} [o.log]
 */
export function createActionRunner({ channel, tts = null, quota = null, log = () => {} } = {}) {
  /** chatId → { id, kind, at } */
  const lastSent = new Map();
  /** `chatId|type|value` → at */
  const mediaSeen = new Map();

  const seen = (chatId, type, value) => {
    const k = `${chatId}\0${type}\0${value}`;
    const now = Date.now();
    if (now - (mediaSeen.get(k) ?? 0) < DEDUPE_MS) return true;
    mediaSeen.set(k, now);
    if (mediaSeen.size > 500) {
      for (const [key, at] of mediaSeen) if (now - at > DEDUPE_MS) mediaSeen.delete(key);
    }
    return false;
  };

  /**
   * 发一轮（一段）内容。
   *
   * @returns {Promise<{ok:boolean, sent:boolean, ...}>} 发送结果，供调用方记日记/冷却
   */
  return async function run({
    text, extra = {}, scene = 'c2c', target = '', msgId = '', receivedAt = 0,
    /** 3.7：事件被动回复（只有 event_id 的事件）；msgId 优先 */
    eventId = '',
    /** 4.6：互动召回，官方 is_wakeup 消息（不校验 msg_id/event_id 有效期） */
    isWakeup = false,
    requestId = '', senderId = '', onSent = () => {},
  } = {}) {
    const ch = channel();
    const { text: body0, actions, wantSkip } = parseOutboundActions(text);
    let body = body0;

    /** 本轮之前自己发的最后一条，`<<retract>>` 撤的是它 */
    const previous = lastSent.get(target) ?? null;
    const wantRetract = actions.some((a) => a.type === 'retract');

    /** 1. 就地插图：上传成 Markdown 素材，占位符换成安全引用 */
    const uploaded = [];
    for (const a of actions.filter((x) => x.type === 'inlineImage')) {
      try {
        const r = await ch.uploadMarkdownImage({ scene, target, path: a.value, retain: false });
        const url = String(r?.url ?? '').trim();
        if (!/^qqbot-media:\/\//i.test(url)) throw new Error('没拿到素材引用');
        body = body.split(a.key).join(`![](${url})`);
        uploaded.push(String(r?.imageId ?? ''));
      } catch (e) {
        /** 失败只把占位符删掉，绝不留本地路径 */
        body = body.split(a.key).join('');
        log(`就地插图没上传成功（已跳过）：${e?.message ?? e}`);
      }
    }

    /** 2. 按钮 / 静默 */
    const buttons = actions.filter((a) => a.type === 'button').map((a) => parseButton(a.value)).filter(Boolean);
    const keyboard = buildKeyboard(buttons);
    const silenceMs = Math.max(
      0,
      ...actions.filter((a) => a.type === 'silence').map((a) => parseDurationMs(a.value)),
      Number(extra?.silenceMs) || 0,
    );

    /** 3. 发正文（含 Markdown / keyboard / 静默） */
    let r = { ok: true, sent: false };
    const skipOnly = wantSkip && !body.trim();
    if (!skipOnly && (body.trim() || silenceMs > 0)) {
      r = await ch.send({
        scene, target, text: body, msgId, receivedAt, eventId, isWakeup, requestId,
        markdown: true, keyboard, silenceMs,
      });
      if (r?.ok) {
        r.sent = true;
        if (r.id) lastSent.set(target, { id: String(r.id), kind: scene, at: Date.now() });
        onSent();
      }
    } else if (skipOnly) {
      log('这一轮是 <skip>：不发消息');
    }

    /** 4. 这一轮要发的文件（原来就在 send() 里，搬过来保持顺序） */
    const files = Array.isArray(extra?.files) ? extra.files.map(String).filter(Boolean) : [];
    for (const f of files) {
      if (typeof ch.sendFile !== 'function') break;
      const rf = await ch.sendFile({ scene, target, path: f, msgId, receivedAt, eventId, isWakeup, requestId: String(extra?.requestId ?? '') })
        .catch((e) => ({ ok: false, message: e?.message ?? String(e) }));
      if (!rf?.ok) log(`发文件失败（${f}）：${rf?.message ?? '未知原因'}`);
      else onSent();
    }

    /** 5. 正文之后的独立媒体：图 / 语音 / 念出来的话 */
    let mediaSent = 0;
    const media = actions.filter((a) => ['imageAlone', 'voice', 'say'].includes(a.type));
    for (const a of media) {
      if (mediaSent >= MAX_MEDIA) break;
      if (a.type === 'imageAlone' && !IMAGE_EXT.test(a.value.split(/[?#]/)[0])) continue;
      if (a.type === 'voice' && !VOICE_EXT.test(a.value.split(/[?#]/)[0])) continue;
      if (seen(target, a.type, a.value)) continue;
      try {
        let sent = null;
        if (a.type === 'imageAlone' && typeof ch.sendFile === 'function') {
          sent = await ch.sendFile({ scene, target, path: a.value, msgId, receivedAt, eventId, isWakeup });
        } else if (a.type === 'voice' && typeof ch.sendVoice === 'function') {
          sent = await ch.sendVoice({ scene, target, path: a.value, msgId, receivedAt, eventId, isWakeup });
        } else if (a.type === 'say' && tts && typeof ch.sendVoice === 'function') {
          /**
           * 「语音条」次数配额。
           *
           * 以前扣在 ai-chat 侧，那边不传 openid，按人算不了，所以
           * `QUOTA_WIRED.voice` 一直是 false、面板显示「暂不生效」。
           * 直连之后 `<<say>>` 在这里执行，发送者身份是现成的（`who`）。
           *
           * **不通过就退化成文字**：这是「防刷屏」不是「不许说话」，
           * 用户还能看到内容；静默丢弃会让她这一句凭空消失。
           */
          const q = quota && typeof quota.charge === 'function'
            ? quota.charge({ feature: 'voice', per: 'person', id: String(senderId || target) })
            : null;
          if (q && q.ok === false) {
            log(`语音条额度用完（${q.message}），这句改发文字`);
            const rt = await ch.send({ scene, target, text: a.value, msgId, receivedAt, eventId, isWakeup });
            if (rt?.ok) { mediaSent += 1; onSent(); }
            continue;
          }
          /** TTS 没启用时旧实现是「连请求都不发」，这里同样静默跳过 */
          const audio = await tts.synthesize(a.value);
          const buf = Buffer.from(audio?.audio ?? []);
          if (!buf.length) throw new Error('合成结果为空');
          const ext = /\bwav\b/i.test(String(audio?.contentType ?? '')) ? '.wav' : '.mp3';
          const file = path.join(os.tmpdir(), `roost-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
          try {
            await writeFile(file, buf);
            sent = await ch.sendVoice({ scene, target, dataBase64: buf.toString('base64'), fileName: path.basename(file), msgId, receivedAt, eventId, isWakeup });
          } finally {
            await rm(file, { force: true }).catch(() => {});
          }
          /** 合成成功但发失败了，把刚扣的额度退回去——那次语音并没有真的出去 */
          if (sent && sent.ok === false && q?.undo) q.undo();
        }
        if (sent?.ok) { mediaSent += 1; onSent(); }
        else if (sent) log(`${a.type} 没发出去：${sent?.message ?? '未知原因'}`);
      } catch (e) {
        /** 语音没开 / 文件不存在 / 上传失败：和旧实现一样不打断这一轮 */
        log(`${a.type} 执行失败（已跳过）：${e?.message ?? e}`);
      }
    }

    /** 6. 撤回上一条（在正文之后，和旧 ai-chat 一致） */
    if (wantRetract && previous?.id && typeof ch.retract === 'function') {
      await ch.retract({ chatId: target, msgId: previous.id, kind: previous.kind || scene })
        .catch((e) => log(`撤回上一条失败：${e?.message ?? e}`));
    }

    /** 7. 用完即删素材（有这个能力才删；失败不影响这轮） */
    if (typeof ch.deleteImage === 'function') {
      for (const id of uploaded.filter(Boolean)) {
        await ch.deleteImage(id).catch(() => {});
      }
    }

    return r;
  };
}
