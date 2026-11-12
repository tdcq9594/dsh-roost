/**
 * roost 事件 → dsh-roost 的 inbound payload
 * ==========================================
 *
 * 直连模式下没有 ai-chat 帮忙整形了，这一层要把它那份活接过来：
 *
 *   · 附件 / 合并转发 / 卡片 → 一段人能读的说明（`rendered`）
 *   · 图片 → 下载、落盘、base64（模型才真的看得见图）
 *   · 权限档位 → 调 `roles.resolve` 算 bucket/level/role
 *
 * **整形规则逐条对齐 ai-chat**（`plugins/ai-chat/inbound.js` + `vision.js`），
 * 其中两条是线上真实踩过的坑，不能图省事：
 *
 *   1. 语音**转写成功时一个字都不写**。以前输出「（发了一条语音）」而转写就
 *      在上一行，模型把那句说明当成实质内容，回「我只看到『发了条语音』」。
 *   2. 以**文件**形式发出来的图要按图说。说成「发了个文件」，模型就只拿到
 *      一个文件名，然后回「我只看得到文件名」——图其实早就摆在它面前了。
 *
 * 与 ai-chat 的差异（都是更严格，不是更松）：`payload.id` 用 `eventId`
 * 而不是随机 UUID，这样它能真的拿去查账本。
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { textOf } from './roost-merge.js';

/** 最多看几张。一张图几百到几千 token，不设上限能把上下文撑爆 */
/** 没传配置时的兜底；真实上限由 `roostHost.maxImages` 热读 */
const DEFAULT_MAX_IMAGES = 4;
/** 单张上限。宁可看不见，也别把请求撑到几 MB */
const MAX_BYTES = 2 * 1024 * 1024;
/** 落盘的图留多久：它会出现在对话上下文里，删太早模型引用就断 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 清理节流：一小时最多扫一次目录 */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweep = 0;

/** 只认这几种，别把奇怪的东西当图喂给模型 */
const OK_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
/** 以「文件」形式发出来的图：扩展名和 contentType 两条线索都认 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 权限档位缓存。同一个人连续说话不该每轮都查一次 */
const PERM_TTL_MS = 60_000;

function dataDir() {
  return process.env.DSH_ROOST_DATA || join(homedir(), '.dsh', 'dsh-roost');
}

function extOf(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function guessMime(buf, declared = '') {
  const d = String(declared).split(';')[0].trim().toLowerCase();
  if (OK_MIME.test(d)) return d;
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** 这个附件能不能当图看 */
export function isImageAttachment(a) {
  if (!a?.url) return false;
  if (a.type === 'image') return true;
  if (a.type !== 'file') return false;
  return IMAGE_EXT.test(String(a.filename || '')) || /^image\//i.test(String(a.contentType || ''));
}

/** 清掉 7 天前的图，一小时最多扫一次 */
function sweep(dir) {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p);
      } catch {
        /* 单个文件删不掉就跳过 */
      }
    }
  } catch {
    /* 目录刚建 / 没权限都不影响这一轮 */
  }
}

/**
 * 图片说明。
 *
 * 四种情况分开说，别让模型猜：
 *   · `'off'`    —— 这一轮关了看图
 *   · `null`     —— 不知道（结构化通道）
 *   · 有项       —— 取到了（有 path 就告诉它路径）
 *   · 空数组     —— 试过但全失败
 */
function imageNote(got, images) {
  if (images === 'off') return '（发来一张图；这一轮没开看图，看不到内容）';
  if (images === null) return '（发来一张图）';
  if (got?.path) return `（发来一张图，已存到本地：${got.path}）`;
  if (got) return '（发来一张图，能看到内容，但没存到本地）';
  return '（发来一张图，但没取到——可以让对方重发）';
}

/** 附件 → 若干行说明 */
export function describeAttachments(evt, images = null) {
  const out = [];
  const list = Array.isArray(images) ? images : [];
  let imgIdx = 0;

  for (const a of evt?.attachments ?? []) {
    switch (a?.type) {
      case 'voice':
        /** 转写成功时一个字都不写：转写本身就是正文，再补说明会把它稀释掉 */
        if (!a.asrText) out.push('（发来一条语音，但没转出文字——可以说没听清，请对方再说一遍）');
        break;
      case 'image': {
        const got = list.find((x) => x.index === imgIdx);
        imgIdx += 1;
        out.push(imageNote(got, images));
        break;
      }
      case 'video':
        out.push('（发了一段视频）');
        break;
      case 'file':
        if (isImageAttachment(a)) {
          const got = list.find((x) => x.index === imgIdx);
          imgIdx += 1;
          out.push(imageNote(got, images));
        } else {
          out.push(`（发了个文件：${a.filename || '未命名'}${a.size ? `，${Math.round(a.size / 1024)}KB` : ''}）`);
        }
        break;
      default:
        if (a?.type) out.push(`（发了一个 ${a.type}）`);
    }
  }
  return out;
}

/** 消息元素 → 若干行说明（合并转发、卡片） */
export function describeElements(evt) {
  const out = [];
  for (const el of evt?.elements ?? []) {
    if (el?.type === 'chatRecord') {
      const body = String(el.content ?? '').trim();
      if (body) out.push(`（合并转发的内容：\n${body.slice(0, 1200)}）`);
    } else if (el?.type === 'ark' && el.ark) {
      out.push(`（卡片消息：${[el.ark.title, el.ark.desc].filter(Boolean).join(' — ') || '无标题'}）`);
    }
  }
  return out;
}

/** 顶层卡片（单独一条卡片消息） */
function describeArk(evt) {
  const a = evt?.ark;
  if (!a) return [];
  const head = [a.title, a.desc].filter(Boolean).join(' — ');
  return [`（卡片消息：${head || a.name || '无标题'}${a.url ? ` ${a.url}` : ''}）`];
}

/**
 * 给模型看的完整用户内容。
 *
 * 顺序有讲究：先说用户打的字，再补上下文（引用、附件、卡片）。
 * 反过来的话模型容易把「（发来一张图）」当成用户说的话。
 */
export function buildRendered(evt, text, { images = null } = {}) {
  const parts = [];
  const said = String(text ?? '').trim();
  if (said) parts.push(said);
  if (evt?.quoted) parts.push(`（引用了这句：${String(evt.quoted).slice(0, 500)}）`);
  parts.push(...describeAttachments(evt, images));
  parts.push(...describeElements(evt));
  parts.push(...describeArk(evt));
  return parts.filter(Boolean).join('\n') || '（发来一条空消息）';
}

/**
 * 造 payload 工厂。
 *
 * @param {object} o
 * @param {(m:string,p?:object,opt?:object)=>Promise<any>} o.rpc
 * @param {(m:string)=>void} [o.log]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {boolean} [o.vision] 这一轮要不要看图
 */
export function createPayloadBuilder({ rpc, log = () => {}, fetchImpl = fetch, vision = true, maxImages = DEFAULT_MAX_IMAGES, markdown = true } = {}) {
  /** 通道到底走不走 Markdown：@ 标签、图文同条、按钮都跟着它变 */
  const wantMarkdown = () => {
    const raw = typeof markdown === 'function' ? markdown() : markdown;
    return raw !== false;
  };
  /** 配置热读：0 = 不看图，上限 8，和旧 ai-chat 的滑杆范围一致 */
  const wantMaxImages = () => {
    const raw = typeof maxImages === 'function' ? maxImages() : maxImages;
    return Math.max(0, Math.min(8, Number(raw) || 0));
  };
  /** key → { at, value } */
  const perms = new Map();
  const imgDir = join(dataDir(), 'images');
  /** 配置热读：面板上关掉看图，下一轮就该生效，不用重启 */
  const wantVision = () => (typeof vision === 'function' ? vision() : vision);

  async function permissionOf(evt) {
    const userId = String(evt?.sender?.openid ?? '').trim();
    if (!userId) return null;
    const kind = evt?.chat?.kind === 'c2c' ? 'c2c' : 'group';
    const key = `${kind}:${evt?.chat?.chatId ?? ''}:${userId}`;
    const hit = perms.get(key);
    if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.value;
    try {
      const v = await rpc('roles.resolve', {
        userId, kind, chatId: String(evt?.chat?.chatId ?? ''),
        groupId: String(evt?.chat?.groupId ?? evt?.chat?.chatId ?? ''),
      });
      const value = v?.bucket ? { bucket: v.bucket, level: v.level, role: v.role } : null;
      perms.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      /** 算不准就别带这几个字段：上层会按「身份不明」处理，比错报成普通成员安全 */
      log(`权限档位查询失败（按身份不明处理）：${e?.message ?? e}`);
      return null;
    }
  }

  /** 下载图片：不走 roost 的 media.fetch，直接抓 QQ 的 URL，和 ai-chat 行为一致 */
  async function collectImages(evt) {
    if (!wantVision()) return 'off';
    const urls = (evt?.attachments ?? []).filter(isImageAttachment).map((a) => String(a.url)).slice(0, wantMaxImages());
    if (!urls.length) return [];

    try {
      mkdirSync(imgDir, { recursive: true });
      sweep(imgDir);
    } catch (e) {
      log(`图片目录不可用（${e?.message ?? e}），这一轮只走内存`);
    }

    const out = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetchImpl(urls[i], { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          log(`图片下载失败（HTTP ${res.status}）`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) {
          log(`图片太大（${Math.round(buf.length / 1024)}KB），跳过`);
          continue;
        }
        const mime = guessMime(buf, res.headers.get('content-type') || '');
        if (!mime) {
          log('不是认识的图片格式，跳过');
          continue;
        }
        /**
         * 文件名只用「消息 id + 序号」。不拿 URL 里的东西拼——那串是外部输入，
         * 带 `../` 或盘符就能写到目录外面去。
         */
        const safeId = String(evt?.msgId || evt?.eventId || 'img').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'img';
        const name = `qq-${safeId}-${i + 1}${extOf(mime)}`;
        let path = '';
        try {
          path = join(imgDir, name);
          writeFileSync(path, buf);
        } catch (e) {
          log(`图片落盘失败（${e?.message ?? e}），这一轮只走内存`);
          path = '';
        }
        out.push({ data: buf.toString('base64'), mediaType: mime, name, path, index: i });
      } catch (e) {
        log(`图片下载出错：${e?.message ?? e}`);
      }
    }
    return out;
  }

  /**
   * 造一条 payload。**异步**：要查权限、要下图。
   *
   * @param {object} evt       roost 的 message 事件 data
   * @param {object} o
   * @param {(text:string, extra?:object)=>Promise<any>} o.send 回复通道
   */
  return async function build(evt, { send } = {}) {
    const kind = evt?.chat?.kind === 'c2c' ? 'c2c' : 'group';
    /**
     * 用 `textOf` 而不是 `evt.content`：纯语音 / 纯图片消息的 content 是空串，
     * 内容在 attachments 里（语音看官方给的 `asrText`）。直接读 content 的话，
     * 用户发一段语音，模型收到的是空字符串。
     */
    const text = textOf(evt);
    const perm = await permissionOf(evt);
    const images = await collectImages(evt);
    const id = String(evt?.eventId || evt?.msgId || '');

    return {
      /**
       * 用 `eventId` 而不是随机 UUID：dsh-roost 会把它当 `source.msgId` 存进
       * 日记，而这个 id 要能反过来查账本（`msg.get` / `ledger.context`）。
       * ai-chat 在这给的是 `evt_xxx`，查不到的。
       */
      id,
      trace: String(evt?.traceId || ''),
      adapter: 'roost-host',
      eventIds: [evt?.eventId].filter(Boolean),
      chat: {
        kind,
        chatId: String(evt?.chat?.chatId ?? ''),
        /**
         * 群名和昵称**不能互相兜底**：群名拿不到时退成发消息人的昵称，
         * 群会话标题就会变成「我的昵称」，和私聊一模一样。
         */
        name: kind === 'c2c' ? String(evt?.sender?.name ?? '') : String(evt?.chat?.name ?? ''),
        groupId: String(evt?.chat?.groupId ?? ''),
        uin: String(evt?.sender?.uin ?? ''),
        groupUin: String(evt?.chat?.groupUin ?? ''),
        /** 人和群分开两组：混用会让群会话读到私聊记忆 */
        aliases: kind === 'c2c'
          ? (Array.isArray(evt?.sender?.aliases) ? evt.sender.aliases : [])
          : (Array.isArray(evt?.chat?.groupAliases) ? evt.chat.groupAliases : []),
      },
      sender: {
        id: String(evt?.sender?.openid ?? ''),
        name: String(evt?.sender?.name ?? ''),
        uin: String(evt?.sender?.uin ?? ''),
        ...(perm ? { bucket: perm.bucket, level: perm.level, role: perm.role } : {}),
      },
      /** 人格归 dsh-roost 自己管，这里不塞 */
      system: '',
      channel: { markdown: wantMarkdown(), files: true },
      text,
      rendered: buildRendered(evt, text, { images }),
      quoted: String(evt?.quoted ?? ''),
      images: Array.isArray(images) ? images : [],
      attachments: Array.isArray(evt?.attachments) ? evt.attachments : [],
      elements: Array.isArray(evt?.elements) ? evt.elements : [],
      history: [],
      /**
       * **没有 url / token**：回复不走 HTTP 回调，走下面的 `__channel.send`。
       * `expiresAt` 还是要给——它是排队预算（`inbound-shell` 用它算 deadline），
       * 和真正发送时的被动窗口不是一回事。
       */
      reply: { expiresAt: Date.now() + 180_000 },
      __channel: { send },
      t: { recv: Number(evt?.at) || 0, start: Date.now() },
    };
  };
}
