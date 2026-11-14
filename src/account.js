/**
 * 账号迁移：把「记忆里躺着的旧 openid」对上号码。
 *
 * ## 为什么需要这一页
 *
 * Roost 面板的「身份」页只能看到**最近发过言**的人。旧记忆里那些早就
 * 没动静的 openid（换了机器人、群解散了、人退了）永远不会出现在那里，
 * 但它们的记忆还在库里躺着——这才是迁移时最需要处理的。
 *
 * 这一页反过来做：**从记忆数据出发**，把所有「认不出号码」的键列出来。
 *
 * ## 三条硬规矩
 *
 * 1. **只读扫描**。`scan()` 不改 memory / journal / graph 一个字节。
 *    唯一的写操作是绑定，而绑定只写 roost 的 `identity.json`。
 * 2. **不猜类型**。`sessions.json` 有 `kind` 就用；没有就标 `unknown`，
 *    让用户在界面上选「群 / 私聊」。猜错了会把群记忆读成人的，
 *    这种错误在界面上完全看不出来，只会表现为「AI 把群友当成了同一个人」。
 * 3. **追加，不替换**。给一个号码补 openid 是**加一条 claim**，
 *    绝不删旧的。删了旧 openid，旧记忆的键就没人引用，AI 立刻读不到——
 *    看起来像「迁移完记忆全没了」。
 *
 * ## 降级
 *
 * roost 没启动时上半区**仍然能扫**（本地数据不需要它），
 * 只是绑定按钮禁用并说明原因。旧版 roost 没有 `/api/identity/*` 时同理。
 */

/**
 * 号码：QQ 号 5–12 位，首位不能是 0。
 *
 * **必须和 roost `src/identity.js` 的 `UIN_RE` 逐字相同**（跨包不能 import，
 * 只能各存一份）。两边判定不同会出现「这边认为没绑定、那边认为已绑定」的
 * 鬼打墙：列表里一直有它，点绑定又报冲突。改一边就要改另一边。
 */
import { unscopeKey } from './persona-scope.js';

const UIN_RE = /^[1-9]\d{4,11}$/;

/**
 * 从任意形态的键里抠出号码。
 *
 * **必须和 roost `src/identity.js` 的 `uinFromKey` 完全一致**——
 * 两边判定不同的话，会出现「这边认为没绑定、那边认为已绑定」的鬼打墙：
 * 列表里一直有它，点绑定又报冲突。改一边就要改另一边。
 *
 * 为什么排除 32 位 hex：openid 是 32 位十六进制，里面全是数字和 a-f，
 * 不排除的话 `55597677 53895AA84...` 这种会被当成一个 8 位号码。
 */
export function uinFromKey(key) {
  const s = String(key ?? '').trim();
  if (!s || s.length > 64) return '';
  if (/^[0-9a-f]{32}$/i.test(s)) return '';

  const parts = s.split(/[^0-9a-zA-Z]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (UIN_RE.test(p)) return p;
    if (/^[0-9a-f]{32}$/i.test(p)) return '';
  }
  return '';
}

/** 号码是否合法（和 roost 同一套规则） */
export function isValidUin(v) {
  return UIN_RE.test(String(v ?? '').trim());
}

/** 反查分片大小：roost 那边 `items.slice(0, 500)` 硬上限 */
const RESOLVE_CHUNK = 500;

export function createAccount({ memory, journal, graph, sessions, setup, log = () => {} }) {
  /**
   * 本地三份数据合并成一张表。
   *
   * 任何一个源坏了都不能让整页挂掉：`journal.sqlite` 打不开（用户删了、
   * 权限不对）时那一列显示 `null`，界面渲染成「—」，绑定照常能做。
   */
  function collect() {
    const acc = new Map();
    /**
     * 4.5：物理键 `xxx::p:<人格>` 是内部记号，账号迁移只认逻辑 openid。
     * 同一逻辑会话在多个人格下各有一条记录时**合并取最大值**，不能相加
     * （共享旧记忆会被每个人格都读到，相加等于重复计数）。
     */
    const touch = (k) => {
      const key = unscopeKey(String(k || ''));
      if (!key) return null;
      let e = acc.get(key);
      if (!e) {
        e = { key, facts: 0, journal: null, edges: null, episodes: null };
        acc.set(key, e);
      }
      return e;
    };
    const maxOf = (cur, next) => Math.max(Number(cur) || 0, Number(next) || 0);

    try {
      for (const { chatId, facts } of memory?.scanKeys?.() ?? []) {
        const e = touch(chatId);
        if (e) e.facts = maxOf(e.facts, facts);
      }
    } catch (e) {
      log(`扫描 memory 失败：${e.message}`);
    }

    try {
      for (const { chatId, journal: n } of journal?.scanChats?.() ?? []) {
        const e = touch(chatId);
        if (e) e.journal = maxOf(e.journal, n);
      }
    } catch (e) {
      log(`扫描 journal 失败：${e.message}`);
    }

    try {
      for (const { chatId, edges, episodes } of graph?.scanChats?.() ?? []) {
        const e = touch(chatId);
        if (!e) continue;
        e.edges = maxOf(e.edges, edges);
        e.episodes = maxOf(e.episodes, episodes);
      }
    } catch (e) {
      log(`扫描 graph 失败：${e.message}`);
    }

    return [...acc.values()];
  }

  /** sessions.json 里的标题/类型。没有就返回空对象，调用方标 unknown */
  function sessionInfo(chatId) {
    try {
      const e = sessions?.entry?.(chatId);
      if (!e) return null;
      return { title: String(e.title || ''), kind: e.kind === 'group' ? 'group' : e.kind === 'c2c' ? 'c2c' : '' };
    } catch {
      return null;
    }
  }

  /**
   * 批量反查「这些 openid 绑到哪个号码了」。
   *
   * 为什么批量而不是拉全表：键可能上千个，一次拉全表既慢又把
   * **别的机器人**的人全拉进浏览器。分片是因为 roost 那边硬上限 500。
   *
   * 失败时返回 `{ ok:false, error }`，调用方据此把按钮禁用并说明原因。
   */
  async function resolveBound(keys) {
    const out = new Map();
    if (!keys.length) return { ok: true, map: out };
    if (!setup?.api) return { ok: false, error: '接入模块未就绪', map: out };

    for (let i = 0; i < keys.length; i += RESOLVE_CHUNK) {
      const chunk = keys.slice(i, i + RESOLVE_CHUNK);
      let r = null;
      try {
        r = await setup.api('/api/identity/resolve', {
          method: 'POST',
          body: JSON.stringify({ items: chunk.map((openid) => ({ openid })) }),
        });
      } catch (e) {
        /**
         * 404 = 旧版 roost 没这个接口；连不上 = 没启动。
         * 两种都只是「不能绑定」，扫描结果照样有用，所以不抛。
         */
        const msg = String(e?.message || e);
        return {
          ok: false,
          error: /404/.test(msg) ? 'Roost 版本太旧，没有身份接口（需要支持「身份」页的版本）' : `连不上 Roost：${msg}`,
          map: out,
        };
      }
      for (const it of r?.items ?? []) {
        const openid = String(it?.query?.openid || it?.openid || '');
        if (!openid) continue;
        if (!it.bound) {
          out.set(openid, null);
          continue;
        }
        out.set(openid, {
          kind: String(it.kind || ''),
          uin: String(it.uin || ''),
          identityId: String(it.identityId || ''),
        });
      }
    }
    return { ok: true, map: out };
  }

  const api = {
    /**
     * 扫一遍本机数据，列出所有「认不出号码」的键。
     *
     * @returns {Promise<{ok:boolean, roost:{ok:boolean,error:string}, items:Array}>}
     */
    async scan() {
      const all = collect();

      /**
       * 键里已经有号码的**不算待迁移**：那说明本来就对上了
       * （老版本手动把号码当 chatId 用的情况）。列出来只会让人误以为
       * 还得再绑一次。
       */
      const rows = all
        .filter((r) => !uinFromKey(r.key))
        .map((r) => {
          const si = sessionInfo(r.key);
          return {
            key: r.key,
            short: r.key.slice(0, 8),
            /** 长度像不像 openid：不像的多半是测试键或手写的假数据，界面标一下 */
            isOpenid: /^[0-9a-f]{32}$/i.test(r.key),
            /** 有 sessions 记录就用它；没有就留空，让用户自己选，**不猜** */
            kind: si?.kind || '',
            title: si?.title || '',
            facts: r.facts,
            journal: r.journal,
            edges: r.edges,
            episodes: r.episodes,
            uin: '',
            bound: null,
          };
        })
        .sort((a, b) => {
          // 有记忆的先出来：一条记忆都没有的键，绑不绑都无所谓
          const w = (x) => (x.facts || 0) + (x.journal || 0) + (x.edges || 0);
          return w(b) - w(a) || a.key.localeCompare(b.key);
        });

      const res = await resolveBound(rows.map((r) => r.key));
      for (const r of rows) r.bound = res.map.get(r.key) ?? null;

      return { ok: true, roost: { ok: res.ok, error: res.error || '' }, items: rows };
    },

    /**
     * 机器人列表（换机器人时要知道往哪个 bot 下面加）。
     * 代理 roost `/api/bots`，连不上就返回空表 + 原因。
     */
    async bots() {
      try {
        const r = await setup.api('/api/bots');
        return { ok: true, bots: r?.bots ?? [], current: r?.current ?? null };
      } catch (e) {
        return { ok: false, error: `连不上 Roost：${String(e?.message || e)}`, bots: [], current: null };
      }
    },

    /**
     * 已绑定的号码（下半区）。
     *
     * 直接代理 roost `/api/identity`：那边已经算好了「已绑 / 未识别」，
     * 这边再算一遍就是两份真相，迟早不一致。
     */
    async boundList() {
      try {
        const r = await setup.api('/api/identity?limit=200');
        return { ok: true, users: r?.users ?? [], groups: r?.groups ?? [], bot: r?.bot ?? '', botName: r?.botName ?? '' };
      } catch (e) {
        const msg = String(e?.message || e);
        return {
          ok: false,
          error: /404/.test(msg) ? 'Roost 版本太旧，没有身份接口' : `连不上 Roost：${msg}`,
          users: [],
          groups: [],
          bot: '',
          botName: '',
        };
      }
    },

    /**
     * 绑定 / 追加。
     *
     * **追加和绑定是同一个调用**：同一个号码下再加一条 openid，
     * 服务端就是往 claims 里 push 一条，不会删旧的。
     * 之所以在界面上分成两个按钮，是为了让用户理解自己在做什么，
     * 不是为了走两条代码路径——两条路径迟早会分叉。
     *
     * `force` 只在「这个 openid 已经属于别的号码」时用（409 之后）。
     */
    async bind({ kind, uin, openid, botId = '', force = false } = {}) {
      const k0 = String(kind ?? '').trim();
      /**
       * **类型必须显式给，不猜。**
       *
       * 以前这里写的是 `kind === 'group' ? 'group' : 'user'`——缺省就静默当人。
       * 面板那边拦住了，但 `/account/bind` 是公开路由，直接 POST 就能绕过去。
       * 猜错的代价是把群记忆绑到 QQ号 下面（或反过来），界面完全看不出来，
       * 只表现为「AI 把群友当成了同一个人」。
       */
      if (k0 !== 'user' && k0 !== 'group' && k0 !== 'c2c') {
        return { ok: false, code: 'INVALID', error: '必须说明是群（group）还是私聊（user/c2c）' };
      }
      const k = k0 === 'group' ? 'group' : 'user';
      const u = String(uin ?? '').trim();
      const o = String(openid ?? '').trim();
      if (!isValidUin(u)) return { ok: false, code: 'INVALID', error: `号码格式不对：${u || '(空)'}` };
      if (!o) return { ok: false, code: 'INVALID', error: '缺少 openid' };
      try {
        const r = await setup.api('/api/identity/bind', {
          method: 'POST',
          body: JSON.stringify({ kind: k, uin: u, openid: o, botId: String(botId || ''), force: force === true }),
        });
        return { ok: true, kind: k, uin: String(r?.uin ?? u), botId: String(r?.botId ?? botId), record: r?.record ?? null };
      } catch (e) {
        const msg = String(e?.message || e);
        /**
         * 409 是「这个 openid 已经属于别的号码」。`owner` 必须带回去，
         * 界面才能问「要不要从 10002 改绑到 10001」。只说「冲突」用户没法决策。
         */
        const conflict = e?.status === 409 || e?.body?.code === 'CONFLICT' || /已被|属于/.test(msg);
        return {
          ok: false,
          code: conflict ? 'CONFLICT' : 'ERROR',
          error: msg,
          owner: String(e?.body?.owner ?? ''),
        };
      }
    },

    /**
     * 批量追加：一个号码 + 多个新 openid，一次提交。
     *
     * **逐条走 `bind()`，不自己拼请求**——两条代码路径迟早会分叉
     * （冲突处理、类型校验、botId 归属都在 bind 里）。
     * 失败的单独报，不影响成功的；界面要能看出哪几条没成。
     */
    async batchAttach({ kind, uin, openids, botId = '' } = {}) {
      const ids = [...new Set((Array.isArray(openids) ? openids : []).map((o) => String(o ?? '').trim()).filter(Boolean))];
      if (!ids.length) return { ok: false, error: '没有选任何 openid' };
      const done = [];
      const failed = [];
      for (const openid of ids) {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.bind({ kind, uin, openid, botId });
        if (r.ok) done.push(openid);
        else failed.push({ openid, code: r.code, error: r.error, owner: r.owner || '' });
      }
      return { ok: done.length > 0, done, failed, uin: String(uin ?? '').trim() };
    },

    /**
     * 「人」的清单：群里发言的人 / 私聊对象。
     *
     * 这一页的 `scan()` 是从**记忆数据**里找「会话键」，而群成员的 openid
     * 根本不会作为 chatId 出现（除非他也开过私聊），所以扫不到。
     * Roost 面板「身份」页的 `unresolved.users` 来自统计库 + 最近发言人，
     * 那里才是这份数据的真相，代理过来省得用户切面板。
     */
    async people() {
      try {
        const r = await setup.api('/api/identity?limit=200');
        /**
         * 字段兜底要**在这里**做，不能靠外层 catch。
         *
         * 以前 `(r?.unresolved?.users ?? []).map(...)` 在 `users` 是字符串、
         * 或数组里混了 null 时会抛 TypeError，被外层 catch 成
         * 「连不上 Roost：...map is not a function」——roost 明明活得好好的，
         * 用户却被指去查连接。旧版 roost 没有 `unresolved` 是正常的，
         * 兜成空表即可。
         */
        const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
        const users = arr(r?.unresolved?.users).map((u) => ({
          openid: String(u.userId ?? u.openid ?? ''),
          name: String(u.name || ''),
          chatId: String(u.chatId || ''),
          scope: String(u.scope || ''),
          lastSeenAt: Number(u.lastSeenAt || u.lastSeen || 0) || 0,
        })).filter((u) => u.openid);
        const groups = arr(r?.unresolved?.groups).map((g) => ({
          openid: String(g.groupOpenid || ''),
          name: String(g.name || g.groupName || ''),
          /**
           * 最后一次说话的毫秒时间。面板上拿它排「最近活跃的群」，
           * 也是「推送不指定群 → 挑最近说话的那个」的排序依据。
           * 旧版 roost 没有这个字段，缺省 0（当作最旧，不会挤掉新的）。
           */
          lastSeenAt: Number(g.lastActiveAt || g.lastSeenAt || 0) || 0,
        })).filter((g) => g.openid);
        return {
          ok: true,
          users,
          groups,
          bot: String(r?.bot || ''),
          botName: String(r?.botName || ''),
        };
      } catch (e) {
        const msg = String(e?.message || e);
        return {
          ok: false,
          error: /404/.test(msg) ? 'Roost 版本太旧，没有身份接口' : `连不上 Roost：${msg}`,
          users: [],
          groups: [],
        };
      }
    },

    /**
     * 换机器人时的候选提示：**只提示，绝不自动绑定**。
     *
     * QQ 官方事件只给 openid，从来不给 QQ号；`uin` 是从绑定表反查出来的。
     * 所以「这个新 openid 是 10001」没有任何权威依据，只能靠名字猜。
     * 猜错了会把别人的记忆串到这个号码下，界面上还完全看不出来——
     * 因此这里只列候选，必须人工勾选确认才进 `batchAttach`。
     */
    async suggest() {
      const [scanRes, bound, peopleRes] = await Promise.all([
        api.scan(),
        api.boundList(),
        api.people(),
      ]);
      /** 候选只能来自「已经绑定过的号码」，没绑过的号码无从谈起 */
      const targets = [
        ...(bound.users || []).map((r) => ({ uin: String(r.uin || ''), kind: 'user', name: String(r.name || r.note || '') })),
        ...(bound.groups || []).map((r) => ({ uin: String(r.groupUin || r.uin || ''), kind: 'group', name: String(r.name || r.note || '') })),
      ].filter((t) => isValidUin(t.uin) && t.name);

      const norm = (s) => String(s || '')
        .replace(/^\s*QQ\s*[·:：-]?\s*/i, '')
        .replace(/[（(].*?[)）]/g, '')
        .replace(/[\s_\-·]/g, '')
        .toLowerCase()
        .trim();

      /** openid → 昵称：优先用 Roost 的最近发言人，其次用会话标题 */
      const nameOf = new Map();
      for (const u of peopleRes.users || []) {
        if (u.openid && u.name) nameOf.set(u.openid, u.name);
      }
      for (const it of scanRes.items || []) {
        if (!nameOf.has(it.key) && it.title) nameOf.set(it.key, it.title);
      }

      const out = [];
      for (const it of scanRes.items || []) {
        if (it.bound) continue;
        const label = norm(nameOf.get(it.key) || it.title);
        if (!label) continue;
        /**
         * 会话类型已知时**直接过滤**，不只是排序。
         *
         * 以前只 `.sort()` 把类型对得上的排前面，但候选里照样会同时出现
         * 「群号 20002」和「QQ号 10001」——注释写着「群号不能配给人」，
         * 实际却把两种都摆出来了。这正是它自己警告的「把群记忆绑到
         * QQ号 下面」。类型未知（老数据没有 sessions 记录）时才两者都给。
         */
        const wantKind = it.kind === 'group' ? 'group' : it.kind ? 'user' : '';
        const hits = targets.filter((t) => {
          if (wantKind && t.kind !== wantKind) return false;
          const n = norm(t.name);
          return n && (n === label || n.includes(label) || label.includes(n));
        });
        if (!hits.length) continue;
        out.push({
          key: it.key,
          label: nameOf.get(it.key) || it.title,
          /** 类型对得上的排前面；群号不能配给人，反之亦然 */
          candidates: hits
            .map((t) => ({
              ...t,
              match: it.kind && ((it.kind === 'group' ? 'group' : 'user') === t.kind) ? 'type' : 'name',
            }))
            .sort((a, b) => (a.match === b.match ? 0 : a.match === 'type' ? -1 : 1)),
        });
      }
      return {
        ok: true,
        items: out,
        /** 界面必须把这句话摆出来 */
        note: '只按名字猜的候选，不是事实。QQ 官方接口不给 QQ号，自动绑错会把别人的记忆串过来 —— 必须人工确认。',
        roost: { ok: peopleRes.ok !== false, error: peopleRes.error || '' },
      };
    },
  };

  return api;
}
