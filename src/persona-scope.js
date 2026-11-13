/**
 * 4.5 人格隔离：归属策略与 store 层键映射。
 *
 * ## 设计前提（主人要求「给用户自己选择的机会」）
 *
 * 旧记忆里没有任何人格标记，归谁都是猜。所以这里**不代定默认**：
 * 关闭隔离时行为与升级前逐字一致；开启隔离必须由使用者在面板上
 * 显式选 A 共享 / B 归某个人格 / C 逐会话指定，没选就不许开。
 *
 * ## 为什么不改 chatId
 *
 * `chat.chatId` 同时是 QQ 出站 target。在入口把它换成 `chatId::p:xxx`，
 * 消息会发不出去，而且不报错。所以只在 **store 层**包装：
 * 逻辑上还是原来的 chatId，物理键才分人格；出站链路完全不碰。
 *
 * ## 为什么不搬旧数据
 *
 * 只写归属标记（`persona-ownership.json`），旧键原地不动。
 * 改主意时改标记即可，不需要 rekey、不需要备份回退——
 * 账号迁移那次「删了旧 openid 整段记忆看起来全没了」不能重演。
 *
 * ## 规则表为什么按「位置」声明（2026-11-13 对抗性测试后重写）
 *
 * 第一版按想象中的方法名写死：`journal.insert`、`recentTimeline` 当成
 * 对象参数……真跑实验发现 `insert` 根本不存在（对外写方法是 `add`），
 * 而且 `search / forget / invalidated / top / endedEdges / suppressEdge`
 * 等一批吃 chatId/aliases 的方法全没进白名单 —— 结果是「日记写共享键、
 * 读物理键」，静默读不到。现在只声明 chatId 与 aliases 的**参数位置**，
 * 由三个通用函数提取/替换/注入，不再猜方法语义。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const LEGACY_POLICIES = Object.freeze(['shared', 'owner', 'perChat']);
export const LEGACY_LABELS = Object.freeze({
  shared: 'A 共享：旧记忆所有人格都能读',
  owner: 'B 归某一个人格：其他人格从空白开始',
  perChat: 'C 逐会话指定：面板上一个个指给人格',
});
export const SCOPE_JOIN = '::p:';

/** 物理键。关闭隔离或没有人格 id 时原样返回（升级前后逐字一致） */
export function scopeKey(chatId, personaId, enabled) {
  const k = String(chatId ?? '');
  const p = String(personaId ?? '').trim();
  if (!enabled || !p || !k) return k;
  return k.includes(SCOPE_JOIN) ? k : `${k}${SCOPE_JOIN}${p}`;
}

/** 从物理键还原逻辑 chatId（面板显示、账号迁移扫描用） */
export function unscopeKey(key) {
  const i = String(key ?? '').indexOf(SCOPE_JOIN);
  return i < 0 ? String(key ?? '') : String(key).slice(0, i);
}

/**
 * 当前人格能看到哪些「旧键」（纯函数，导出给测试）。
 *
 * 返回的是要追加到 aliases 里的键；账号别名（换机器人用的号码/旧 openid）
 * 由调用方原样保留，人格隔离绝不能把它们弄丢。
 */
export function legacyKeysFor({
  chatId = '', personaId = '', policy = '', owner = '',
  byChat = {}, marks = {}, enabled = false,
} = {}) {
  const k = String(chatId ?? '').trim();
  if (!enabled || !k || !personaId) return [];
  switch (policy) {
    case 'shared': return [k];
    case 'owner': return String(owner) && personaId === String(owner) ? [k] : [];
    case 'perChat': {
      const want = String(byChat?.[k] ?? marks?.[k] ?? '').trim();
      return want && want === personaId ? [k] : [];
    }
    default: return [];  /** 没选策略：一条旧记忆也不额外放进来 */
  }
}

/** 归属标记账本：单独一份文件，不塞进 memory.json */
export function createOwnership({ file, log = () => {} } = {}) {
  let data = { policy: '', owner: '', byChat: {}, marks: {} };
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      data = {
        policy: LEGACY_POLICIES.includes(raw?.policy) ? raw.policy : '',
        owner: String(raw?.owner ?? ''),
        byChat: raw?.byChat && typeof raw.byChat === 'object' ? raw.byChat : {},
        marks: raw?.marks && typeof raw.marks === 'object' ? raw.marks : {},
      };
    }
  } catch (e) {
    log(`人格归属账本读不出来，按空账继续：${e.message}`);
  }
  const get = () => ({ ...data, byChat: { ...data.byChat }, marks: { ...data.marks } });
  return {
    get,
    save(patch = {}) {
      const next = {
        policy: LEGACY_POLICIES.includes(patch.policy) ? patch.policy : data.policy,
        owner: String(patch.owner ?? data.owner ?? ''),
        byChat: patch.byChat && typeof patch.byChat === 'object' ? { ...patch.byChat } : data.byChat,
        marks: patch.marks && typeof patch.marks === 'object' ? { ...patch.marks } : data.marks,
      };
      if (!LEGACY_POLICIES.includes(next.policy)) next.policy = '';
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
        renameSync(tmp, file);
      } catch (e) {
        log(`人格归属账本写盘失败：${e.message}`);
        return { ok: false, error: e.message };
      }
      data = next;
      return { ok: true, ...get() };
    },
  };
}

/**
 * 规则表：`chat` = chatId 在哪，`alias` = aliases 在哪，`mode` = 读/写。
 *
 *   chat:  0 / 1 / ...       → args[n] 是字符串 chatId
 *          'obj:0' / 'obj:1' → args[n] 是对象，取 .chatId
 *          'row:0'           → args[n] 是写入行对象，取 .chatId
 *   alias: 0 / 1 / ...       → args[n] 是别名数组，追加
 *          'obj:0' / 'obj:1' → args[n] 对象的 .aliases 追加
 *          null              → 不追加（写操作、删除操作）
 *
 * `mode:'read'` 才追加归属允许的旧键；`write` 只换物理键，
 * 绝不让删除跨到共享键（方案文档 §2 第 1 层的硬要求）。
 */
export const PLAN = {
  memory: {
    list: [0, 1, 'read'], listRanked: [0, 1, 'read'], listFull: [0, 1, 'read'],
    getPersonaOverride: [0, 1, 'read'], hasAuthz: [0, 2, 'read'], authz: [0, null, 'read'],
    add: [0, null, 'write'], supersede: [0, null, 'write'],
    setPersonaOverride: [0, null, 'write'], setAuthz: [0, null, 'write'],
    remove: [0, null, 'write'], clearChat: [0, null, 'write'],
  },
  journal: {
    /** 对外写方法是 add；insert / searchTerms / withVec 是底层内部方法，不暴露，不用包 */
    add: ['row:0', null, 'write'],
    recent: [0, 3, 'read'], listChat: [0, 2, 'read'], digests: [0, 2, 'read'],
    recentTimeline: [0, 'obj:1', 'read'], top: [0, 'obj:1', 'read'],
    search: ['obj:1', 'obj:1', 'read'],
    invalidated: ['obj:0', 'obj:0', 'read'],
    forget: ['obj:0', null, 'write'],
    clearChat: [0, null, 'write'], purgeChat: [0, null, 'write'],
  },
  graph: {
    nowEdges: ['obj:0', 'obj:0', 'read'], entities: ['obj:0', 'obj:0', 'read'],
    isSuppressed: ['obj:0', 'obj:0', 'read'], endedEdges: ['obj:0', 'obj:0', 'read'],
    text: ['obj:0', 'obj:0', 'read'], suppressed: ['obj:0', 'obj:0', 'read'],
    hasActive: ['obj:2', 'obj:2', 'read'], linkedJournalIds: ['obj:1', 'obj:1', 'read'],
    edgesAsOf: ['obj:1', 'obj:1', 'read'], episodes: ['obj:0', null, 'write'],
    addEdge: ['obj:0', null, 'write'], closeEdge: ['obj:0', null, 'write'],
    suppressEdge: ['obj:0', null, 'write'], unsuppressEdge: ['obj:0', null, 'write'],
    addEpisode: ['obj:0', null, 'write'], purgeChat: [0, null, 'write'],
  },
  sessions: {
    get: [0, null, 'read'], set: [0, null, 'write'], entry: [0, null, 'read'],
    getEntry: [0, null, 'read'],
    remove: [0, null, 'write'], patch: [0, null, 'write'],
  },
};

const posOf = (spec) => (typeof spec === 'number' ? { i: spec, obj: false }
  : typeof spec === 'string' && spec.startsWith('obj:') ? { i: Number(spec.slice(4)), obj: true }
    : typeof spec === 'string' && spec.startsWith('row:') ? { i: Number(spec.slice(4)), obj: true }
      : null);

const chatAt = (args, spec) => {
  const p = posOf(spec);
  if (!p) return '';
  const v = args[p.i];
  return String(p.obj ? v?.chatId ?? '' : v ?? '');
};

const setChat = (args, spec, value) => {
  const p = posOf(spec);
  if (!p) return args;
  const next = args.slice();
  const v = next[p.i];
  next[p.i] = p.obj
    ? { ...(v && typeof v === 'object' ? v : {}), chatId: value }
    : value;
  return next;
};

const addAliases = (args, spec, extra) => {
  const p = posOf(spec);
  if (!p || !extra.length) return args;
  const next = args.slice();
  const v = next[p.i];
  const arr = p.obj ? (Array.isArray(v?.aliases) ? v.aliases : []) : (Array.isArray(v) ? v : []);
  const merged = [...arr, ...extra.filter((x) => !arr.includes(x))];
  next[p.i] = p.obj ? { ...(v && typeof v === 'object' ? v : {}), aliases: merged } : merged;
  return next;
};

/**
 * @param {object} o
 * @param {()=>object} o.cfgOf      返回当前配置
 * @param {(chatId:string)=>string} o.personaOf  **按 chatId** 返回人格；
 *        后台任务用的 chatId 不在映射里，自动落回共享键，不需要全局开关
 * @param {object} o.ownership     归属账本
 */
export function createPersonaScope({ cfgOf = () => ({}), personaOf = () => '', ownership, log = () => {} } = {}) {
  const own = ownership || { get: () => ({ policy: '', owner: '', byChat: {}, marks: {} }), save: () => ({ ok: true }) };
  const state = () => {
    const c = cfgOf()?.persona?.scope || {};
    const o = own.get();
    /**
     * B 模式没指定 owner 时不生效：账本被手工写坏也不能让旧记忆整体消失。
     * 正常路径 /persona/scope/save 已经拦 400，这里是第二道闸。
     */
    const usable = LEGACY_POLICIES.includes(o.policy)
      && (o.policy !== 'owner' || Boolean(String(o.owner || '').trim()));
    return {
      enabled: c.enabled === true && usable,
      wanted: c.enabled === true,
      policy: o.policy, owner: o.owner, byChat: o.byChat, marks: o.marks,
      personaOf,
    };
  };
  const legacy = (chatId) => {
    const s = state();
    return legacyKeysFor({
      chatId, personaId: String(personaOf(chatId) || ''),
      policy: s.policy, owner: s.owner, byChat: s.byChat, marks: s.marks,
      enabled: s.enabled,
    });
  };
  const phys = (chatId) => scopeKey(chatId, personaOf(chatId), state().enabled);

  function wrap(store, kind) {
    const rules = PLAN[kind] || {};
    if (!store || typeof store !== 'object') return store;
    const out = { ...store };
    for (const [name, [chatSpec, aliasSpec, mode]] of Object.entries(rules)) {
      if (typeof store[name] !== 'function') continue;
      const fn = store[name].bind(store);
      out[name] = (...args) => {
        if (!state().enabled) return fn(...args);
        const raw = chatAt(args, chatSpec);
        /** 没给 chatId 的全库操作（如 invalidated({limit})）原样放行 */
        if (!raw) return fn(...args);
        let next = setChat(args, chatSpec, phys(raw));
        if (mode === 'read') next = addAliases(next, aliasSpec, legacy(raw));
        return fn(...next);
      };
    }
    return out;
  }

  return {
    state,
    scopeKey: phys,
    legacyKeys: legacy,
    wrapMemory: (s) => wrap(s, 'memory'),
    wrapJournal: (s) => wrap(s, 'journal'),
    wrapGraph: (s) => wrap(s, 'graph'),
    wrapSessions: (s) => wrap(s, 'sessions'),
    log,
  };
}
