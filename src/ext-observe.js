/**
 * 扩展侧的「只看不改」一组：日记 / 用量 / 自我表达 / 表情库
 * =================================================================
 *
 * 这一组全是**读**，scope 统一 `state:read` 或 `memory:read`，装扩展时不用
 * 额外点头。挑进来的是「扩展真会用到、而 `/v1` 原来完全没有」的那几样：
 *
 *   · `GET /v1/journal`        她的日记（最近 / 关键词检索 / 摘要）
 *   · `GET /v1/usage`          模型用量与花费
 *   · `GET /v1/self`           她现在叫什么、签名是什么、头像是什么
 *   · `GET /v1/stickers`       表情库里有哪些图
 *   · `GET /v1/stickers/file`  取某一张的字节（base64）
 *
 * ## 两条刻意的收窄
 *
 * 1. **表情列表不给绝对路径**。面板需要 `path` / `root`（它要拼 `file://`），
 *    扩展不需要——给了等于把用户的家目录结构摊出去。这里只给 `rel`
 *    （`分类/文件名`），取图也用它。
 * 2. **日记正文截断**。面板一次只显示前 200 字，扩展拿到全文没有意义，
 *    反而会把几万字的原文塞进模型上下文。这里按 500 码点截。
 *
 * ## 为什么不给 `/self/qq`
 *
 * 面板那条是「把任意 QQ API 方法原样转给框架」（`qq.call`）。给它开一个
 * `/v1` 口子，`/v1/roost.call` 那套「只读 + 插件工具 + msg.send」的白名单
 * 就全废了。扩展要走 QQ 能力请用 `/v1/roost.call`。
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { locate } from './sticker-manage.js';
import { normalizeSelfExpression } from './self-expression.js';

/** 日记一次最多多少条 */
export const MAX_JOURNAL_ROWS = 100;
/** 日记正文截断（按码点，emoji 不会被切成半个） */
export const JOURNAL_CLIP = 500;
/** 表情列表一次最多多少张 */
export const MAX_STICKER_ROWS = 500;
/** 取图上限：再大就不该走 JSON 了（base64 会膨胀 4/3） */
export const MAX_STICKER_BYTES = 8 * 1024 * 1024;
/** 会话 id 上限。官方 openid 三四十字符，128 已经很宽松 */
export const MAX_CHAT_ID = 128;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function bad(message, status = 400, error = 'bad_request') {
  return { status, body: { ok: false, error, message } };
}

const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/**
 * 读会话 id：**不截断**，超长直接报错。
 * 截断后的 id 可能正好等于另一个真实会话，于是「读 A 群日记」变成「读 B 群」。
 */
function readChatId(raw) {
  const v = String(raw ?? '').trim();
  if (v.length > MAX_CHAT_ID) {
    return { error: `chatId 太长了（${v.length} 字符，上限 ${MAX_CHAT_ID}）` };
  }
  return { value: v };
}
const clip = (v, n = JOURNAL_CLIP) => {
  const s = String(v ?? '');
  const arr = Array.from(s);
  return arr.length > n ? `${arr.slice(0, n).join('')}…` : s;
};

/**
 * @param {object} p
 * @param {()=>object} p.journalOf
 * @param {()=>object} p.usageOf
 * @param {()=>object} p.stickersOf
 * @param {()=>object} p.cfgOf
 * @param {()=>object} p.selfHistoryOf  `createHistory()` 实例（read()）
 * @param {(chatId:string)=>string[]} p.aliasesOf
 */
export function createExtObserve({
  journalOf, usageOf, stickersOf, cfgOf,
  selfHistoryOf = () => ({ read: () => [] }),
  aliasesOf = () => [],
} = {}) {
  if (typeof journalOf !== 'function') throw new Error('观察接口需要 journalOf');
  if (typeof stickersOf !== 'function') throw new Error('观察接口需要 stickersOf');
  if (typeof cfgOf !== 'function') throw new Error('观察接口需要 cfgOf');

  return {
    /**
     * `GET /v1/journal` —— 她的日记。
     *
     * `?chatId=` 看哪个会话（不给就是空）、`?q=` 走全文检索、`?limit=`
     * （默认 20，上限 100）、`?digests=1` 顺带带上最近几天的摘要。
     */
    async 'journal.read'({ query } = {}) {
      const got = readChatId(query?.chatId);
      if (got.error) return bad(got.error);
      const chatId = got.value;
      const q = str(query?.q, 200);
      const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), MAX_JOURNAL_ROWS);
      const wantDigests = String(query?.digests ?? '') === '1';
      const j = journalOf();

      try {
        if (q) {
          const rows = await j.search(q, { chatId, limit, aliases: aliasesOf(chatId) }) ?? [];
          return {
            status: 200,
            body: {
              ok: true,
              backend: j.backend?.(),
              q,
              total: rows.length,
              items: rows.map((r) => ({
                id: String(r.id ?? ''),
                at: Number(r.at) || 0,
                level: String(r.level ?? ''),
                text: clip(r.text),
                digest: r.digest ? clip(r.digest, 200) : '',
                score: Number(r.score) || 0,
                why: String(r.why ?? ''),
              })),
            },
          };
        }
        const rows = j.recent?.(chatId, limit, 'chat', aliasesOf(chatId)) ?? [];
        return {
          status: 200,
          body: {
            ok: true,
            backend: j.backend?.(),
            chatId: chatId || null,
            total: rows.length,
            items: rows.map((r) => ({
              id: String(r.id ?? ''),
              at: Number(r.at) || 0,
              level: String(r.level ?? ''),
              text: clip(r.text),
              digest: r.digest ? clip(r.digest, 200) : '',
              invalid: Boolean(r.invalidAt),
            })),
            ...(wantDigests
              ? {
                digests: (j.digests?.(chatId, 7, aliasesOf(chatId)) ?? []).map((d) => ({
                  at: Number(d.at) || 0,
                  text: clip(d.text ?? d.digest, 400),
                })),
              }
              : {}),
          },
        };
      } catch (e) {
        return bad(`读日记失败：${e?.message ?? e}`, 500, 'internal');
      }
    },

    /** `GET /v1/usage?days=` —— 用量与花费（1–90 天，默认 7） */
    async 'usage.read'({ query } = {}) {
      const days = Math.min(Math.max(Number(query?.days) || 7, 1), 90);
      try {
        const sum = usageOf().summary({ days, pricing: cfgOf()?.usage?.pricing }) ?? {};
        return { status: 200, body: { ok: true, days, ...sum } };
      } catch (e) {
        return bad(`读用量失败：${e?.message ?? e}`, 500, 'internal');
      }
    },

    /**
     * `GET /v1/self` —— 她现在的对外形象（名字 / 签名 / 头像设定）。
     *
     * 只给 `selfExpression` 这一段，不带平台实时状态：那个要 `dev.bot.get`，
     * 需要开发者登录态，失败是常态，塞进这里会让扩展以为「读失败了」。
     */
    async 'self.read'() {
      const cfg = cfgOf() || {};
      const se = normalizeSelfExpression(cfg.selfExpression);
      let history = [];
      try {
        history = (selfHistoryOf().read() ?? []).slice().reverse().slice(0, 10);
      } catch { /* 历史读不到不影响当前值 */ }
      return { status: 200, body: { ok: true, cfg: se, history } };
    },

    /**
     * `GET /v1/stickers` —— 表情库列表。
     *
     * **不给绝对路径**（见文件头）。`rel` 是 `分类/文件名`，拿去调
     * `/v1/stickers/file?path=` 取图。
     */
    async 'stickers.list'({ query } = {}) {
      const cfg = cfgOf() || {};
      const q = str(query?.q, 100).toLowerCase();
      const cat = str(query?.category, 100);
      const limit = Math.min(Math.max(Number(query?.limit) || 100, 1), MAX_STICKER_ROWS);

      let snap;
      try {
        snap = stickersOf().snapshot(cfg.stickers) ?? {};
      } catch (e) {
        return bad(`读表情库失败：${e?.message ?? e}`, 500, 'internal');
      }
      const all = Array.isArray(snap.items) ? snap.items : [];
      const matched = all
        .filter((it) => (cat ? String(it.cat ?? '') === cat : true))
        .filter((it) => {
          if (!q) return true;
          const hay = [it.file, it.rel, it.usage, ...(it.tags || [])].join(' ').toLowerCase();
          return hay.includes(q);
        });
      const rows = matched.slice(0, limit).map((it) => ({
        rel: String(it.rel ?? it.file ?? ''),
        file: String(it.file ?? ''),
        category: String(it.cat ?? ''),
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [],
        usage: String(it.usage ?? ''),
        bytes: Number(it.size) || 0,
      }));

      return {
        status: 200,
        body: {
          ok: true,
          /** 打不开的目录：只回「0 张」的话，看不出是路径错还是真没图 */
          missing: Array.isArray(snap.missing) ? snap.missing : [],
          categories: Array.isArray(snap.cats) ? snap.cats : [],
          /** `total` 是库里一共多少张，`matched` 是这次筛选命中多少张 */
          total: all.length,
          matched: matched.length,
          items: rows,
        },
      };
    },

    /**
     * `GET /v1/stickers/file?path=分类/文件名` —— 取一张图的字节。
     *
     * 为什么要给字节：`/v1/send` 的 `files` **只收扩展自己目录下的路径**
     * （见 `ext-api-hooks.js` 的 `safeExtFile`），表情库在别处，扩展拿不到
     * 可直接发送的路径。所以给它 base64，让它落一份到自己目录再发。
     *
     * 路径校验走 `locate()`：它只认「分类/文件名」两层、挡 `..`、且要求
     * 结果落在某个已配置的根目录下。
     */
    async 'stickers.file'({ query } = {}) {
      const rel = str(query?.path ?? query?.rel, 300);
      if (!rel) return bad('缺 path（分类/文件名，或直接文件名）');
      const cfg = cfgOf() || {};
      let roots = [];
      try {
        roots = stickersOf().snapshot(cfg.stickers)?.roots ?? [];
      } catch (e) {
        return bad(`读表情库失败：${e?.message ?? e}`, 500, 'internal');
      }
      const hit = locate(roots, rel);
      if (!hit) return bad(`没有这张图：${rel}`, 404, 'not_found');

      let buf;
      try {
        buf = readFileSync(hit.abs);
      } catch (e) {
        return bad(`读不到这张图：${e?.message ?? e}`, 500, 'internal');
      }
      if (buf.length > MAX_STICKER_BYTES) {
        return bad(`这张图太大了（${buf.length} 字节，上限 ${MAX_STICKER_BYTES}）`, 413, 'request_too_large');
      }
      return {
        status: 200,
        body: {
          ok: true,
          rel: hit.rel,
          file: hit.name,
          category: hit.category,
          contentType: MIME[extname(hit.abs).toLowerCase()] || 'application/octet-stream',
          bytes: buf.length,
          data: buf.toString('base64'),
        },
      };
    },
  };
}
