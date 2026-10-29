/**
 * 投递终态跟踪
 * ============
 *
 * 一句话：**主动发出去但还在审核的消息，过一阵子要回来问一句「到底过没过」。**
 *
 * ── 为什么需要 ──
 *
 * 官方对主动消息做内容审核。进审核时接口回的是 304023，ai-chat 把它翻成
 * `pending: true`——「待审核」既不是送到也不是没送到。而审核结果的事件
 * （`MESSAGE_AUDIT_PASS` / `MESSAGE_AUDIT_REJECT`）推给的是**框架侧**
 * （持有 QQ 连接的那个进程），dsh-roost 收不到任何推送。
 *
 * 不跟踪的后果不是「少一条日志」，是**她会坚称自己说过一句没人看见的话**：
 * 审核驳回之后，日记、自我叙述、群里的节奏记账都还按「说过了」往下走。
 *
 * ── 状态机 ──
 *
 *   waiting ──查一次──┬── pending / audited ──→ 还是 waiting（下次再问）
 *                     ├── sent ───────────────→ sent
 *                     ├── failed ─────────────→ failed（含审核驳回，带 code）
 *                     ├── unknown ────────────→ unknown（**永不重发**）
 *                     └── gone ───────────────→ gone（账本里没这条，放弃跟踪）
 *
 * 三个非显然的点：
 *
 * 1. **`unknown` 和 `failed` 要分开。** `failed` 是「确定没发出去」，
 *    可以再发一次；`unknown` 是「不知道发没发」——重发可能让用户收到两条。
 *    这两者在面板上必须长得不一样，否则人会按错按钮。
 *
 * 2. **查询失败（网络/插件没起）不等于发送失败。** 保持 `waiting` 下次再问，
 *    绝不能因为「问不到」就结案——那会把一条其实发出去的消息记成没发。
 *
 * 3. **`gone` 要放弃而不是重试。** 账本里没有这条记录的原因很多
 *    （插件没开账本、框架太老、记录过了保留期），无论哪种，继续问都是白问。
 *
 * ── 为什么不复用 `awake` 的 state ──
 *
 * `awake.json` 存的是「这个群今天说了几次、下次什么时候能说」——是**节奏**。
 * 这里存的是「某一条消息的归宿」——是**账**。两者生命周期差一个数量级
 * （节奏按天滚，账要留几天给人核对），混在一起以后谁都不敢清。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 一条消息最多留几天等结果。超过就当没结果，别让文件无限长 */
export const TTL_MS = 3 * 86_400_000;
/** 有结果的记录留多久（面板要能回看「昨天那条被驳了」） */
export const KEEP_MS = 2 * 86_400_000;
/** 最多存多少条 */
export const MAX_ITEMS = 200;

/** 已经定论的状态。`waiting` / `pending` / `audited` 都还在等 */
const SETTLED = new Set(['sent', 'failed', 'unknown', 'gone']);

/** 每条的正文摘要上限（面板显示用，不存全文） */
const TEXT_MAX = 60;

/**
 * @param {object} o
 * @param {string} o.file         存盘路径
 * @param {() => object|null} o.channelOf 取通道（拿它的 `delivery()` 查询）
 * @param {() => number} [o.now]
 * @param {(m:string)=>void} [o.log]
 */
export function createDeliveryTrack({ file, channelOf, now = () => Date.now(), log = () => {} } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      cache = {
        items: items
          .filter((x) => x && typeof x.requestId === 'string' && x.requestId)
          .map((x) => ({
            requestId: x.requestId,
            scene: x.scene === 'group' ? 'group' : 'c2c',
            target: String(x.target ?? ''),
            chatId: String(x.chatId ?? x.target ?? ''),
            text: String(x.text ?? '').slice(0, TEXT_MAX),
            at: Number(x.at) || 0,
            state: String(x.state || 'waiting'),
            code: String(x.code || ''),
            parts: Number(x.parts) || 0,
            checkedAt: Number(x.checkedAt) || 0,
          })),
      };
    } catch {
      cache = { items: [] };
    }
    return cache;
  }

  function save() {
    const m = load();
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
      renameSync(tmp, file); // 原子替换，断电不会留半个文件
    } catch {
      /* 写不进去就算了，不能因为记账把这一轮弄挂 */
    }
  }

  /**
   * 清掉过期的。
   *
   * 两类分开清：还在等的按 `TTL_MS`（3 天没结果就别等了），
   * 已有结果的按 `KEEP_MS`（留 2 天够人回看）。
   */
  function prune() {
    const m = load();
    const t = now();
    const before = m.items.length;
    m.items = m.items.filter((x) => {
      if (SETTLED.has(x.state)) return t - (x.at || 0) < KEEP_MS;
      return t - (x.at || 0) < TTL_MS;
    });
    // 还是太多就砍最老的（正常不会有，防的是异常刷屏）
    if (m.items.length > MAX_ITEMS) {
      m.items.sort((a, b) => b.at - a.at);
      m.items.length = MAX_ITEMS;
    }
    return before - m.items.length;
  }

  /**
   * 登记一条「等确认」的消息。
   *
   * 只在 `send` 回 `pending: true` 时调。已经确定送达的不必跟踪——
   * 多存一条就是多一次无谓的 HTTP 查询。
   *
   * @param {{requestId:string, scene?:string, target?:string, chatId?:string, text?:string}} p
   * @returns {boolean} 有没有真的登记（缺 id 就不登）
   */
  function note({ requestId, scene = 'c2c', target = '', chatId = '', text = '' } = {}) {
    const id = String(requestId ?? '').trim();
    if (!id) return false;
    const m = load();
    const existed = m.items.find((x) => x.requestId === id);
    if (existed) {
      /**
       * 同一个 id 又登记一次（重试 / 上层重复调用）：不新建，只刷新时间。
       * 新建的话查询会查两遍，面板上也会出现两条一模一样的东西。
       */
      existed.at = now();
      existed.state = 'waiting';
      save();
      return true;
    }
    m.items.push({
      requestId: id,
      scene: scene === 'group' ? 'group' : 'c2c',
      target: String(target ?? ''),
      chatId: String(chatId ?? target ?? ''),
      text: String(text ?? '').slice(0, TEXT_MAX),
      at: now(),
      state: 'waiting',
      code: '',
      parts: 0,
      checkedAt: 0,
    });
    prune();
    save();
    return true;
  }

  /**
   * 把一条查询结果翻译成新状态。
   *
   * 单独抽出来是因为这里有唯一一处「什么算结案」的判断，
   * 散在 `resolve` 里最容易漏掉某个分支（比如把 `gone` 当失败重试）。
   *
   * @param {object} r 通道 `delivery()` 的返回
   * @param {string} prev 当前状态
   * @returns {{state:string, settled:boolean}}
   */
  function nextState(r, prev = 'waiting') {
    if (!r) return { state: prev, settled: false };
    if (r.gone) return { state: 'gone', settled: true };
    /**
     * 网络类错误 / 没回 JSON：**不是结论**，保持原样下次再问。
     * 这里如果顺手记成 failed，一条其实已经送达的消息就被记成没发了。
     */
    if (!r.ok) return { state: prev, settled: false };
    const s = String(r.state || '');
    if (s === 'sent') return { state: 'sent', settled: true };
    if (s === 'failed') return { state: 'failed', settled: true };
    if (s === 'unknown') return { state: 'unknown', settled: true };
    // pending / audited / 认不出来的：还在等
    return { state: 'waiting', settled: false };
  }

  /**
   * 问一圈。
   *
   * 一次最多查 `limit` 条（默认 10）：这是挂在觉醒 tick 上的，
   * 一次查几十条会把这个 tick 拖长，而结果又不急在这一分钟。
   *
   * @param {{limit?:number}} [o]
   * @returns {Promise<{checked:number, settled:Array<object>, still:number, skipped:boolean}>}
   */
  async function resolve({ limit = 10 } = {}) {
    const m = load();
    const waiting = m.items.filter((x) => !SETTLED.has(x.state));
    if (!waiting.length) return { checked: 0, settled: [], still: 0, skipped: false };

    const ch = channelOf?.() ?? null;
    if (!ch || typeof ch.delivery !== 'function') {
      /**
       * 通道不支持查询（老版本 ai-chat）：不查，但也不结案。
       * 这些条目会一直留在 waiting 直到过期——面板上能看见，
       * 总比悄悄丢掉强。
       */
      return { checked: 0, settled: [], still: waiting.length, skipped: true };
    }

    // 先查最老的：最老的等得最久，也最可能已经有结果
    const batch = waiting.slice().sort((a, b) => a.at - b.at).slice(0, Math.max(1, Number(limit) || 10));

    /**
     * **并发查，不串行。**
     *
     * 串行的代价是线性的：一条 5 秒超时，10 条就是 50 秒——面板上点
     * 「回查一次」会转圈到人以为卡死，定时器那一轮也会拖住后面的活。
     * 这些请求打到的是本机 ai-chat 的只读路由，并发几条没有任何压力。
     *
     * 查询本身是纯读，结果统一收集后再改内存，所以并发不会写出半截状态。
     */
    const answers = await Promise.all(
      batch.map(async (x) => {
        try {
          return await ch.delivery(x.requestId);
        } catch (e) {
          return { ok: false, message: e?.message ?? String(e) };
        }
      }),
    );

    const settled = [];
    for (let i = 0; i < batch.length; i++) {
      const x = batch[i];
      const r = answers[i];
      const nx = nextState(r, x.state);
      x.checkedAt = now();
      if (nx.state !== x.state) {
        x.state = nx.state;
        x.code = String(r?.code || '');
        x.parts = Number(r?.parts) || 0;
        if (nx.settled) {
          settled.push({ ...x });
          const why = x.code ? `（${x.code}）` : '';
          log(`投递终态：${x.requestId} → ${x.state}${why} · ${x.scene}:${String(x.target).slice(0, 8)}`);
        }
      }
    }
    prune();
    save();
    return {
      checked: batch.length,
      settled,
      still: m.items.filter((x) => !SETTLED.has(x.state)).length,
      skipped: false,
    };
  }

  return {
    note,
    resolve,
    nextState,
    /** 还在等的（面板「待确认」） */
    pending: () => load().items.filter((x) => !SETTLED.has(x.state)),
    /** 全部，新的在前（面板用） */
    list: () => load().items.slice().sort((a, b) => b.at - a.at),
    get: (requestId) => load().items.find((x) => x.requestId === String(requestId ?? '')) ?? null,
    /** 某条消息是不是已经确认送达（`self` / 日记判断「我说过」时用） */
    isSent: (requestId) => load().items.find((x) => x.requestId === String(requestId ?? ''))?.state === 'sent',
    stats: () => {
      const items = load().items;
      const by = {};
      for (const x of items) by[x.state] = (by[x.state] || 0) + 1;
      return { total: items.length, by, pending: items.filter((x) => !SETTLED.has(x.state)).length };
    },
    prune,
  };
}
