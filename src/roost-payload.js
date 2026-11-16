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
import { clipQuote, describeQuoteAttachments } from './inbound.js';

/** 最多看几张。一张图几百到几千 token，不设上限能把上下文撑爆 */
/** 没传配置时的兜底；真实上限由 `roostHost.maxImages` 热读 */
const DEFAULT_MAX_IMAGES = 4;
/** 单张上限。宁可看不见，也别把请求撑到几 MB */
const MAX_BYTES = 2 * 1024 * 1024;
/**
 * 下载重试：QQ 图片 CDN 偶发抖动 / 连接被重置时，一次失败不该让整轮
 * 消息变成「发来一张图，但没取到——可以让对方重发」。
 *
 * 只对**可恢复**的失败重试：网络异常、超时、408/425/429/5xx。
 * 404 / 403（链接过期、防盗链）、超大文件、非图片格式都是确定性失败，
 * 重试只会白等，直接跳过。每次尝试单独超时，最多 3 次 + 两段短退避。
 */
const IMAGE_TRIES = 3;
const IMAGE_RETRY_MS = [180, 450];
const IMAGE_ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
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
  if (mime === 'image/bmp') return '.bmp';
  return '.jpg';
}

/**
 * 判图片真实类型：**先看文件头，再看声明**。
 *
 * 顺序反了等于没做。QQ 网关把发上来的图片**统一标成 `image/png`**，
 * `content_type` 不可信（dsh-qqbot 的 `transport/attachment.ts` 也专门点了这个坑）。
 * 老实现先信声明、嗅头部只当兜底，于是兜底永远走不到：一张 GIF 被标成 png，
 * 就按 `.png` 落盘、`mediaType` 也报错，模型读图那一步直接失败。
 *
 * 太短的 buffer（< 12 字节）没法嗅，这时才退回声明——极小的图几乎不存在，
 * 真遇到也至少别误杀。
 */
export function guessMime(buf, declared = '') {
  if (buf && buf.length >= 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  }
  const d = String(declared).split(';')[0].trim().toLowerCase();
  return OK_MIME.test(d) ? d : '';
}

/**
 * 嗅文件头，认「所有」图片格式（含模型不收的 bmp），只用于**落盘扩展名**。
 *
 * 两层要分开，别合成一个函数：
 *   · `guessMime`   → 只认模型收得下的 4 种，决定 `mediaType`
 *   · `sniffImageType` → 多认一个 bmp，决定文件名后缀
 *
 * dsh-qqbot 也是这个分工（`transport/attachment.ts` 认 5 种用于改扩展名，
 * `media/vision-tool.ts` 只认 4 种喂模型）。合成一个的后果是：bmp 被
 * `image/bmp` 一路带到模型那边，直接报「不支持的图片格式」。
 *
 * 以前 bmp 走的是更糟的一条路：文件头认不出 → 退回声明 → QQ 网关统一标
 * `image/png` → 按 `.png` 落盘、按 `image/png` 喂模型，字节和声明对不上。
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 2) return '';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return guessMime(buf, '');
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
  /** 认得出格式但模型收不下（目前只有 BMP）：别骗它「已存到本地」，它读不了 */
  if (got?.unsupported) {
    return got.path
      ? `（发来一张 ${String(got.mediaType || '').replace('image/', '').toUpperCase()} 图，这个格式我看不了，已存到本地 ${got.path}；可以说没看清，请对方转成 PNG / JPG 重发）`
      : '（发来一张 BMP 图，这个格式我看不了；可以说没看清，请对方转成 PNG / JPG 重发）';
  }
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
  if (evt?.quoted) parts.push(`（引用了这句：${clipQuote(evt.quoted)}）`);
  /** 与 renderInbound 共用同一段输出，两条路径必须逐字一致（quote-clip Q6） */
  parts.push(...describeQuoteAttachments(evt));
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
 * @param {boolean|'auto'|(()=>boolean|'auto')} [o.vision] 这一轮要不要看图
 * @param {(o:{chatId:string,kind:string})=>Promise<boolean|null>} [o.canSee]
 *        `vision === 'auto'` 时问一句「这个模型能不能看图」；
 *        返回 `null` = 宿主没声明，按「照发」处理
 * @param {(attempt:number)=>number} [o.retryDelayMs] 重试退避毫秒；测试传 `() => 0`
 */
export function createPayloadBuilder({
  rpc, log = () => {}, fetchImpl = fetch, vision = true,
  maxImages = DEFAULT_MAX_IMAGES, markdown = true, canSee = null,
  retryDelayMs = null,
} = {}) {
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

  /**
   * 这一轮到底发不发图。
   *
   * `'auto'` 要问宿主「这个模型能不能看图」，所以是异步的；只有**明确说看不了**
   * 才降级成文字提示。探测失败 / 宿主没声明 / 抛错，一律按「发」处理——
   * 宁可多带一张图，也别因为问不到就把用户发的图丢掉。
   */
  async function visionOn(evt) {
    const raw = wantVision();
    if (raw !== 'auto') return raw !== false;
    if (typeof canSee !== 'function') return true;
    try {
      const v = await canSee({
        chatId: String(evt?.chat?.chatId ?? ''),
        /** 四态投影：dm 与 c2c 同属一对一 */
        kind: (evt?.chat?.kind === 'c2c' || evt?.chat?.kind === 'dm') ? 'c2c' : 'group',
      });
      return v !== false;
    } catch (e) {
      log(`问「这个模型能不能看图」失败（按能看处理）：${e?.message ?? e}`);
      return true;
    }
  }

  async function permissionOf(evt) {
    const userId = String(evt?.sender?.openid ?? '').trim();
    if (!userId) return null;
    /** 保留四态：宿主协议 roles.resolve 现在认 guild/dm，频道权限走 channel:${groupId} scope */
    const k = evt?.chat?.kind;
    const kind = ['group', 'c2c', 'guild', 'dm'].includes(k) ? k : 'group';
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
    if (!(await visionOn(evt))) return 'off';
    const urls = (evt?.attachments ?? []).filter(isImageAttachment).map((a) => String(a.url)).slice(0, wantMaxImages());
    if (!urls.length) return [];

    try {
      mkdirSync(imgDir, { recursive: true });
      sweep(imgDir);
    } catch (e) {
      log(`图片目录不可用（${e?.message ?? e}），这一轮只走内存`);
    }

    const out = [];
    let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      let saved = false;
      for (let attempt = 1; attempt <= IMAGE_TRIES && !saved; attempt += 1) {
        const again = () => attempt < IMAGE_TRIES;
        const wait = () => {
          const ms = typeof retryDelayMs === 'function'
            ? retryDelayMs(attempt)
            : (IMAGE_RETRY_MS[attempt - 1] ?? 0);
          return Number(ms) > 0 ? new Promise((r) => setTimeout(r, Number(ms))) : Promise.resolve();
        };
        try {
          const res = await fetchImpl(urls[i], {
            signal: AbortSignal.timeout(IMAGE_ATTEMPT_TIMEOUT_MS),
          });
          if (!res.ok) {
            const status = Number(res.status);
            const retry = again() && RETRY_STATUS.has(status);
            log(`图片下载失败（HTTP ${status}，第 ${attempt}/${IMAGE_TRIES} 次）${retry ? '，稍后重试' : ''}`);
            if (!retry) break;
            await wait();
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MAX_BYTES) {
            log(`图片太大（${Math.round(buf.length / 1024)}KB），跳过`);
            break;
          }
          /**
           * 文件名只用「消息 id + 序号」。不拿 URL 里的东西拼——那串是外部输入，
           * 带 `../` 或盘符就能写到目录外面去。
           */
          const safeId = String(evt?.msgId || evt?.eventId || 'img').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'img';
          const declared = res.headers.get('content-type') || '';

          /**
           * BMP 单独走：认得出、按 `.bmp` 落盘，但**不喂给模型**。
           *
           * 模型侧只收 png/jpeg/gif/webp（同事的 `inspectImageFormat` 白名单、
           * 本文件 `OK_MIME` 都是这四种）。以前 bmp 的文件头认不出 → 退回 QQ
           * 网关统一标的 `image/png` → 按 `.png` 落盘、把 bmp 字节当 png 喂模型，
           * 结果是「图存错了 + 模型读图报错」。现在明确告诉模型这个格式看不了，
           * 让它请对方重发，落盘文件后缀也对得上。
           *
           * `data` 留空：下游 `turn.js` 的 `if (!img?.data) continue` 和
           * `ext-llm.js` 的 `data.length > 100` 过滤都会自然跳过，不会把
           * `image/bmp` 带进请求；`index` 照样占位，describeAttachments 的
           * 配对不会错位。
           */
          if (sniffImageType(buf) === 'image/bmp') {
            const name = `qq-${safeId}-${i + 1}.bmp`;
            let path = '';
            try {
              path = join(imgDir, name);
              writeFileSync(path, buf);
            } catch (e) {
              log(`BMP 落盘失败（${e?.message ?? e}），这一轮只给文字说明`);
              path = '';
            }
            out.push({ data: '', mediaType: 'image/bmp', name, path, index: i, unsupported: true });
            log('发来一张 BMP：模型看不了这个格式，已落盘并请对方转 PNG/JPG 重发');
            saved = true;
            break;
          }

          const mime = guessMime(buf, declared);
          if (!mime) {
            log('不是认识的图片格式，跳过');
            break;
          }
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
          saved = true;
        } catch (e) {
          /** fetch 抛错 / arrayBuffer 中途断流，都算可恢复的网络问题 */
          log(`图片下载出错（第 ${attempt}/${IMAGE_TRIES} 次）：${e?.message ?? e}${again() ? '，稍后重试' : ''}`);
          if (!again()) break;
          await wait();
        }
      }
      if (!saved) failed += 1;
    }
    if (failed) {
      log(`这一轮 ${failed}/${urls.length} 张图没取到（已重试 ${IMAGE_TRIES} 次），模型只看到文字提示`);
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
    const k = evt?.chat?.kind;
    const kind = ['group', 'c2c', 'guild', 'dm'].includes(k) ? k : 'group';
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
        /**
         * 频道维度**必须透传**：框架 `bot/src/host/serialize.js` 已经给了
         * `chat.guildId` / `chat.channelId`，这里以前丢了，导致下游全拿不到：
         *   · `chatOf().sessionKey` 的 `guildId` 恒空 → 退化成按子频道分会话；
         *   · `speakerTag` 的 `[子频道 <id>]` 只剩 `?`；
         *   · 频道事件过滤的双保险（guildId/channelId 非空）恒不命中。
         * 2026-11-15 核查抓到，属已上线 bug。
         */
        guildId: String(evt?.chat?.guildId ?? ''),
        channelId: String(evt?.chat?.channelId ?? ''),
        /**
         * 跨应用群标识（2026-11-16），**只透传**。它换不出群 openid、不能拿去
         * 发消息；跨机器人关联仍走 identity 的「群号 ↔ openid」绑定。
         */
        unionGroupId: String(evt?.chat?.unionGroupId ?? ''),
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
        /**
         * 2026-11-16 起框架会把昵称/头像一起带出来（群聊是群内昵称）：
         * `name` 是显示名，`nickname`/`card` 是原始的两个名字，`avatar` 是原图。
         * 只透传，不在这里挑——下游要哪个由它自己决定。
         */
        nickname: String(evt?.sender?.nickname ?? ''),
        card: String(evt?.sender?.card ?? ''),
        avatar: String(evt?.sender?.avatar ?? ''),
        unionOpenid: String(evt?.sender?.unionOpenid ?? ''),
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
