/**
 * 对话收尾：**她也会把话说完，然后退场**。
 *
 * 这一层解决的是「永远在接话」的问题。没有收尾时她的行为是：
 * 对方说「我去睡了」，她回一句「晚安」，下一次醒来又当无事发生接着找话——
 * 因为系统里根本没有「这段聊完了」这个概念。
 *
 * 抄的是 SurfCore 的 `qq_close_conversation`（MIT），三条关键设计：
 *
 *   1. **收尾不发消息**，只记「收在哪、下次怎么接」——说了再见就真的停，
 *      不再硬补一句「那你早点睡呀～」。
 *   2. **对方还在提问时拒绝收尾**——问题没答完就退场，是最让人恼火的一种。
 *   3. **收尾是状态，不是遗忘**——记忆一条不动，只是这段对话有了句号。
 *
 * 我们自己加一条：**只做私聊**。群里没有「聊完」这回事，一直有人说话，
 * 记一条「收尾」反而会让下次接话莫名其妙。
 *
 * 为什么单独一个模块（不塞进 memory.js）：
 * memory 存的是「她记得的事」（只增、有衰减、参与检索）；
 * 收尾存的是「这段对话的状态」（覆盖式更新、会过期、参与唤醒判定）。
 * 两者生命周期完全不同，混在一起早晚互相污染。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULTS = {
  enabled: true,
  /** 收尾记录多久后失效。太旧的「上次聊到」接上去反而怪 */
  ttlDays: 7,
  /** 收尾后多久内不主动搭话——刚说完晚安，十分钟后又冒出来最假 */
  coolMinutes: 90,
  /** 最多留几个会话的收尾记录，防止文件无限长 */
  maxChats: 200,
};

/** 收尾后冷却期（毫秒） */
export function coolMs(cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  return Math.max(0, Number(c.coolMinutes) || 0) * MINUTE;
}

/**
 * 把 `<<close: ...>>` 里的内容拆成「收在哪」和「下次怎么接」。
 *
 * 写法：`收在哪 | 下次怎么接`，竖线后半可省。
 * 不写竖线时整段当「收在哪」——模型经常只写一句，别因此丢掉。
 *
 * @param {string} raw
 * @returns {{ point: string, resume: string }}
 */
export function parseClose(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { point: '', resume: '' };
  // 中英文竖线都认
  const i = s.search(/[|｜]/);
  if (i < 0) return { point: s.slice(0, 120), resume: '' };
  return {
    point: s.slice(0, i).trim().slice(0, 120),
    resume: s.slice(i + 1).trim().slice(0, 120),
  };
}

/**
 * 这一句是不是在提问。
 *
 * 只认**硬信号**：问号结尾，或句中出现明确的疑问/求助词。
 *
 * 为什么不做得更"聪明"：这是**拒绝收尾**的闸门，误判的代价不对称——
 * 该收没收只是多聊一句，不该收却收了是"问题没答完就跑了"。
 * 所以宁可只挡最明确的那些，其余交给提示词里的软约束。
 *
 * @param {string} text
 */
export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return /(怎么|为什么|为啥|能不能|可不可以|是不是|要不要|有没有|多少|几点|怎么办|请问|帮我|教我)/.test(s);
}

/**
 * 这次收尾该不该接受。
 *
 * 抽成纯函数是因为三条拒绝**全是静默失败**——错了不会有任何报错，
 * 只会表现成「她刚道完晚安又冒出来」或者「问题没答完就跑了」。
 * 这类东西必须能直接测，不能靠线上观察。
 *
 * @param {{ point?:string, kind?:string, said?:string }} o
 *        `said` 是对方**这一轮**说的话（用来判断还在不在提问）
 * @returns {{ ok:boolean, why:string }}
 */
export function acceptClose({ point = '', kind = 'group', said = '' } = {}) {
  const p = String(point ?? '').trim();
  if (!p) return { ok: false, why: '没写收在哪' };
  if (kind !== 'c2c') return { ok: false, why: '只做私聊' };
  if (looksLikeQuestion(said)) return { ok: false, why: '对方还在提问，不能先跑' };
  return { ok: true, why: '' };
}

/** 毫秒 → 人话 */
function ago(ms) {  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function createClosing(cfg = {}) {
  const file = () => join(dataDir(), 'closing.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      cache = raw && typeof raw === 'object' && raw.chats ? raw : { chats: {} };
    } catch {
      cache = { chats: {} };
    }
    return cache;
  }

  function save() {
    try {
      mkdirSync(dataDir(), { recursive: true });
      const tmp = file() + '.tmp';
      writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
      renameSync(tmp, file());
    } catch {
      /* 存不下就算了——收尾是锦上添花，不能因为写盘失败把这一轮弄挂 */
    }
  }

  /**
   * 配置可以是对象，也可以是 getter。
   *
   * 宿主的 `cfg` 是 `let`（面板保存时整个替换），传快照的话
   * 「改了配置不生效，得重启」——这类问题最难查，所以这里直接支持函数。
   */
  function conf() {
    const raw = typeof cfg === 'function' ? cfg() : cfg;
    return { ...DEFAULTS, ...(raw || {}) };
  }

  /** 一条记录还算不算数（没过期） */
  function alive(rec, now = Date.now()) {
    if (!rec || !rec.at) return false;
    return now - rec.at <= conf().ttlDays * DAY;
  }

  return {
    /**
     * 记一次收尾。
     *
     * @param {string} chatId
     * @param {{ point:string, resume?:string, why?:string, turns?:number, kind?:string }} rec
     * @returns {{ ok:boolean, why:string }}
     */
    set(chatId, rec = {}) {
      const c = conf();
      if (!c.enabled) return { ok: false, why: '收尾没开' };
      if (!chatId) return { ok: false, why: '没有 chatId' };
      /**
       * **只做私聊。** 群里不收尾：`kind` 明确是 group 的直接拒。
       * 没传 kind 的按私聊处理（老调用方不知道这个参数）。
       */
      if (rec.kind === 'group') return { ok: false, why: '群里不收尾' };

      const point = String(rec.point ?? '').trim().slice(0, 120);
      if (!point) return { ok: false, why: '没写收在哪' };

      const db = load();
      db.chats[chatId] = {
        at: Date.now(),
        point,
        resume: String(rec.resume ?? '').trim().slice(0, 120),
        why: String(rec.why ?? '').trim().slice(0, 60),
        turns: Number.isFinite(rec.turns) ? Number(rec.turns) : 0,
      };
      this.prune();
      save();
      return { ok: true, why: point };
    },

    /** 拿一条（过期的不算） */
    get(chatId) {
      const db = load();
      const rec = db.chats[chatId];
      if (!alive(rec)) return null;
      return { ...rec };
    },

    /** 主动清掉（对方又聊起来了、或者用户要求别记） */
    clear(chatId) {
      const db = load();
      if (!db.chats[chatId]) return false;
      delete db.chats[chatId];
      save();
      return true;
    },

    /**
     * 注入给模型的一段话。**没有记录就返回空串**——不要注入
     * 「上次没有收尾记录」这种废话，那是白吃 token。
     */
    text(chatId) {
      const rec = this.get(chatId);
      if (!rec) return '';
      const parts = [
        '【上次这段聊到】',
        `收在：${rec.point}`,
      ];
      if (rec.resume) parts.push(`可以这么接：${rec.resume}`);
      parts.push(`（${ago(Date.now() - rec.at)}。是同一段聊天的延续，不用重新自我介绍，也不用当作没发生过。）`);
      return parts.join('\n');
    },

    /**
     * 刚收过尾吗。
     *
     * 主动搭话（`awake.js`）用它踩刹车：刚说完「晚安」，90 分钟内不该
     * 又冒出来问「在干嘛」。**只影响随性搭话，不影响「约定」**——
     * 答应过的事该提还是要提。
     */
    coolingDown(chatId, now = Date.now()) {
      const rec = load().chats[chatId];
      if (!alive(rec, now)) return false;
      const ms = coolMs(conf());
      return now - rec.at < ms;
    },

    /** 超过 maxChats 或已过期就清掉，防止文件无限长 */
    prune(now = Date.now()) {
      const c = conf();
      const db = load();
      const keys = Object.keys(db.chats);
      let changed = false;

      for (const k of keys) {
        if (!alive(db.chats[k], now)) {
          delete db.chats[k];
          changed = true;
        }
      }

      const rest = Object.keys(db.chats);
      if (rest.length > c.maxChats) {
        // 最旧的先走
        rest
          .sort((a, b) => (db.chats[a].at || 0) - (db.chats[b].at || 0))
          .slice(0, rest.length - c.maxChats)
          .forEach((k) => {
            delete db.chats[k];
            changed = true;
          });
      }

      if (changed) save();
      return changed;
    },

    /** 面板用：所有还活着的记录（按时间倒序） */
    list() {
      const db = load();
      return Object.entries(db.chats)
        .filter(([, r]) => alive(r))
        .map(([chatId, r]) => ({ chatId, ...r }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
    },

    /** 面板用 */
    stat() {
      const db = load();
      const live = Object.values(db.chats).filter((r) => alive(r));
      return { total: live.length, max: conf().maxChats };
    },
  };
}
