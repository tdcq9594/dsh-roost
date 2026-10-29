/**
 * 凌晨巩固：把昨天的一天"睡一觉消化掉"。
 *
 * 为什么放在凌晨：白天不该为记忆花一分钱。打分、压缩、抽三元组这些
 * 都要调模型，一旦塞进对话链路，每条消息都要多一次调用（比聊天本身还贵）。
 * 攒到凌晨，一天一次，成本可以忽略。
 *
 * 做五件事：
 *   1. 打分     ── 模型复核昨天的三级判断（白天的规则只是粗分）
 *   2. 升降级   ── 升级的变"重要"，降级的变"普通"（**critical 不许降**）
 *   3. 到期压缩 ── 到期的日记压成一句/半句，**原文不动**
 *   4. 提取约定 ── "说好下次…"进长期记忆和知识图谱（约定是有状态的，办完要关掉）
 *   5. 一句摘要 ── 昨天一句话，注入时用它顶一整天
 *   顺带抽三元组进图谱——抽错也不要紧，episode 留着能重建。
 *
 * **只是提醒，不是命令**（大肥鱼原话）：模型给的等级建议是"建议"，
 * 这里有硬护栏——不删任何东西、不降 critical、单次改动有上限。
 * 模型抽风时宁可少改，不能把记忆改坏。
 */

import { dayOf } from './journal.js';
import { RE_CORRECTION, MIN_BOT_LINES } from './self.js';

/** 单次巩固最多改多少条等级。防模型一口气把整天的日记全升成 critical */
const MAX_RANK_CHANGES = 30;

/** 一次喂给模型的最大条数 / 字数。超了按"等级高优先 + 时间新优先"截 */
const MAX_ROWS = 80;
const MAX_INPUT_CHARS = 6000;

/** 一天最多处理几个会话。群特别多的部署要收敛，不然凌晨会连发几十次调用 */
const MAX_CHATS_PER_RUN = 5;

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 昨天的日期串（巩固处理的是"刚过完的那一天"） */
export function yesterdayOf(now = Date.now()) {
  return dayOf(now - 86_400_000);
}

/**
 * 从模型输出里抠 JSON。
 *
 * 不能直接 JSON.parse：模型十次有三次会包一层 ```json 或者前后带一句话。
 * 抠第一个 `{` 到最后一个 `}` 是这类场景的通用解法。
 */
export function parseJsonLoose(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 没有模型（或模型抽风）时的机械压缩。
 *
 * 截前 40 字而不是"丢掉"：铁律是压不是删，机械手段也得遵守。
 * 截出来的东西当然不如模型写的那句，但它至少留住了开头那半句。
 */
export function mechanicalDigest(text, max = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * 按"等级高 + 时间新"挑要喂给模型的条目，并压到字数上限。
 */
export function pickRows(rows, { maxRows = MAX_ROWS, maxChars = MAX_INPUT_CHARS } = {}) {
  const W = { critical: 3, important: 2, normal: 1 };
  const sorted = [...rows].sort(
    (a, b) => (W[b.level] ?? 1) - (W[a.level] ?? 1) || b.at - a.at,
  );
  const out = [];
  let used = 0;
  for (const r of sorted) {
    const line = `[${r.id}] ${hhmm(r.at)} ${r.role === 'bot' ? '她' : r.sender || '某人'}(${r.level}): ${r.text}`;
    if (out.length >= maxRows || used + line.length > maxChars) continue;
    out.push({ row: r, line });
    used += line.length;
  }
  // 喂给模型时按时间正序，读起来才像一天
  out.sort((a, b) => a.row.at - b.row.at);
  return out;
}

/** 拼提示词 */
export function buildPrompt({ day, chatName, items }) {
  return [
    `下面是你 ${day} 这天在「${chatName || '一个会话'}」里聊过的话（她=你自己说的，其他人=对方说的）。`,
    '请做四件事，只输出一个 JSON，不要解释、不要代码块围栏：',
    '',
    '1. summary：把这一天写成**一句话**，不超过 60 字。要具体（谁说了什么要紧的事），不要写"聊了一些话题"。',
    '2. ranks：你觉得等级判错了的条目，给 ["id","等级"]。等级只能是 critical / important / normal。',
    '   · critical = 关于这个人身份的事实、他明确要求你记住的',
    '   · important = 情绪、约定、偏好、值得记住的细节',
    '   · normal = 寒暄、"嗯""好"这类',
    '3. compress：已经过时的日常琐碎，压成一句（不超过 40 字）。压缩时**必须原样保留**这几类：',
    '   人名 / 地名 / 物品名 / 数字 / 日期与时间 / 待办与承诺 / 否定（他说“不要什么”）/ 金额。',
    '   不要写成“某个地方”“那个东西”——以后要靠这些名词才找得到。真正重要的事不要放进这里。',
    '   （为什么要逐条点名：只说“保留重要信息”时，模型会把“答应下周三前给答复”这种带时间的承诺压掉，',
    '     它在模型的判断里不够“重要”，但漏掉就是忘了答应过的事。）',
    '4. triples：从里面抽出"谁—什么关系—什么"的三元组，格式',
    '   {"s":"主语","rel":"关系","o":"宾语","scope":"global"|"chat","op":"add"|"update"|"invalidate"}。',
    '   · op=add：新事实，和已有的不冲突',
    '   · op=update：**同一个人同一关系换了值**（"住在"从杭州变上海）→ 会自动把旧的那条作废',
    '   · op=invalidate：这条不再成立，而且没有新值（分手了、搬走了但没说去哪）',
    '   · 拿不准就写 add——写 update 会关掉旧值，宁可多留一条也不要误删',
    '   · scope=global：关于主人本人的事实（住处、名字、生日、工作、长期偏好）',
    '   · scope=chat：只在这个群成立的（群友的绰号、群内梗、小圈子关系）',
    '   · rel 用两三个字的动词或名词（住在/喜欢/叫/生日是/工作在/养了/认识）',
    '   · 没有可抽的就给空数组',
    '5. agreements：里面出现的"约定 / 答应 / 说好要办的事"，一条一句；没有就给空数组',
    '6. closed：以前答应过、今天明显已经办完的约定，给 [{"s":"主语","rel":"约定","o":"那件事"}]；没有就给空数组',
    '',
    '输出格式（严格按这个键名）：',
    '{"summary":"...","ranks":[["id","level"]],"compress":[{"id":"...","digest":"..."}],',
    ' "triples":[{"s":"...","rel":"...","o":"...","scope":"global"}],"agreements":["..."],"closed":[]}',
    '',
    '—— 下面是一天的记录 ——',
    ...items.map((i) => i.line),
  ].join('\n');
}

/**
 * 拼自述的提示词（第五层）。
 *
 * 和巩固其他几件事分开拼、单独调一次：素材不同——这里要的是**她自己说过的话**
 * 和**被纠正的时刻**，而巩固给的是混在一起的一整天。混在同一个 prompt 里，
 * 模型会把它写成第二份日记摘要。
 *
 * @param {object} o
 * @param {string} o.day
 * @param {Array<{text:string, at:number}>} o.said  当天她自己说过的话
 * @param {Array<{text:string, at:number}>} o.corrected 被纠正时对方说的话
 */
export function buildSelfPrompt({ day, said = [], corrected = [] } = {}) {
  const lines = [
    `下面是 ${day} 你自己说过的话（只有你说的），以及今天被对方纠正的时刻。`,
    '',
    '请用两三句话写下**关于你自己**的：',
    '· 今天你觉得自己哪里做得不够好',
    '· 你打算怎么改',
    '· 或者你对自己的新发现',
    '',
    '要求：',
    '· 只写你自己。不要写对方的事、不要复述聊了什么——那是日记的活。',
    '· 不要写「作为 AI」「作为一个语言模型」。',
    '· 不超过 100 字，口语，像随手记的一笔。',
    '· 今天确实没什么可写的，就只输出 `<<skip>>`，什么都别加。',
    '',
    '—— 你说过的话 ——',
    ...said.map((x) => `· ${x.text}`),
  ];
  if (corrected.length) {
    lines.push('', '—— 被纠正的时刻 ——', ...corrected.map((x) => `· ${x.text}`));
  }
  return lines.join('\n');
}

/**
 * @param {object} o
 * @param {object} o.journal  createJournal() 的返回
 * @param {object} o.graph    createGraph() 的返回
 * @param {object} o.memory   createMemory() 的返回（约定要沉进 facts）
 * @param {object} [o.self]   createSelf() 的返回（第五层：自我叙述）
 * @param {(p:string)=>Promise<string>} [o.generate] 没给就只做机械压缩
 */
export function createConsolidate({ journal, graph, memory, self = null, generate = null, log = () => {}, now = () => Date.now() } = {}) {
  /** 上一次的结果，面板和 /consolidate 接口读它 */
  let last = null;
  let running = false;

  /** 这天这个会话是不是已经巩固过了（摘要条目在就算） */
  function done(day, chatId) {
    return Boolean(journal.get(`day:${day}:${chatId || 'global'}`));
  }

  /**
   * 巩固一天。
   *
   * @param {object} o
   * @param {string} [o.day]  'YYYY-MM-DD'，默认昨天
   * @param {boolean} [o.dry] 只算不写（调试用）
   */
  async function run({ day = '', dry = false } = {}) {
    const t = now();
    const target = String(day || yesterdayOf(t));
    if (running) return { ok: false, reason: '上一次巩固还没跑完' };
    running = true;

    const stats = {
      ok: true,
      day: target,
      at: t,
      dry,
      chats: 0,
      rows: 0,
      ranked: 0,
      compressed: 0,
      triples: 0,
      agreements: 0,
      closed: 0,
      digests: 0,
      /** 被墓碑挡下来的条数（用户删过、巩固又抽出来的） */
      suppressed: 0,
      /** 第五层：这条自述写没写（0/1），没写的理由放 selfSkip */
      self: 0,
      selfSkip: '',
      mode: generate ? 'model' : 'mechanical',
      errors: [],
    };

    try {
      const rows = journal.byDay(target);
      stats.rows = rows.length;

      /** 没有日记也要建摘要（"这天没说话"本身是信息），但只在有模型时才有意义 */
      if (!rows.length) {
        stats.ok = false;
        stats.reason = '这天没有日记';
        last = stats;
        return stats;
      }

      /** 按会话分组：串场防护要求摘要和三元组都带归属 */
      const groups = new Map();
      for (const r of rows) {
        const k = r.chatId || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }

      const todo = [...groups.entries()].filter(([cid]) => !done(target, cid)).slice(0, MAX_CHATS_PER_RUN);
      stats.skipped = [...groups.keys()].filter((cid) => done(target, cid));
      if (groups.size > MAX_CHATS_PER_RUN) {
        stats.truncated = [...groups.keys()].slice(MAX_CHATS_PER_RUN);
        log(`今天有 ${groups.size} 个会话，先处理 ${MAX_CHATS_PER_RUN} 个，其余留到明天`);
      }

      for (const [chatId, list] of todo) {
        stats.chats += 1;
        const items = pickRows(list);
        const chatName = list.find((r) => r.chatId === chatId)?.chatId?.slice(0, 8) || '';
        let plan = null;

        if (generate) {
          try {
            const raw = await generate(buildPrompt({ day: target, chatName, items }));
            plan = parseJsonLoose(raw);
            if (!plan) {
              log(`巩固 ${target}/${chatName}：模型输出不是 JSON，退回机械压缩`);
              stats.errors.push('模型输出解析失败');
            }
          } catch (e) {
            log(`巩固 ${target}/${chatName} 调模型失败：${e.message}`);
            stats.errors.push(`调模型失败：${e.message}`);
          }
        }

        const res = apply({ day: target, chatId, list, plan, dry });
        for (const k of ['ranked', 'compressed', 'triples', 'agreements', 'closed', 'digests', 'suppressed']) {
          stats[k] += res[k] || 0;
        }

        /**
         * 摘要条目：即使模型给了 summary 也要落一条。
         * 没有模型时写机械摘要（"这天聊了 N 句"），
         * 因为注入那边按"有没有摘要"决定深度，缺了会一直深度重注。
         */
        if (!dry) {
          const summary =
            String(plan?.summary ?? '').trim() ||
            `这天聊了 ${list.length} 句${list.length > 6 ? '，其中有些值得记的' : ''}。`;
          journal.add({
            id: `day:${target}:${chatId || 'global'}`,
            at: list[list.length - 1].at,
            chatId,
            role: 'digest',
            kind: 'digest',
            level: 'important',
            text: summary.slice(0, 200),
          });
          stats.digests += 1;
        }
      }

      /**
       * 第五层：自述。
       *
       * 放在所有会话处理完之后，用**跨群的汇总**写一条——
       * 自述是关于「她这个人」的，一个群一份会分裂成好几个她。
       * 素材和巩固其他几件事不同（只有她自己说的话 + 被纠正的时刻），
       * 所以单独拼 prompt、单独调一次，不和 summary/ranks 混在一起。
       */
      if (self && generate && !dry) {
        try {
          const r = await writeSelf({ day: target, rows });
          if (r.written) stats.self = 1;
          else stats.selfSkip = r.why || '';
        } catch (e) {
          stats.errors.push(`写自述失败：${e.message}`);
          log(`写自述失败：${e.message}`);
        }
      }

      /** 顺手补向量的位置：这里只报数，实际补算由宿主在填充向量后调 setVec */
      stats.needVec = journal.noVec(20).length;
    } catch (e) {
      stats.ok = false;
      stats.reason = e?.message ?? String(e);
      log(`巩固失败：${stats.reason}`);
    } finally {
      running = false;
    }

    last = stats;
    return stats;
  }

  /**
   * 写一条自述。
   *
   * 触发条件是 **C 方案：按量 or 被纠正**：
   *   · 按量：当天她自己说了 `MIN_BOT_LINES` 条以上 —— 冷清的一天硬写一条
   *     「今天没说什么」，只是往库里灌水
   *   · 被纠正：**哪怕只说了三句**也要写。被纠正那一刻是最值钱的素材，
   *     纯按量的话「说错一句就被怼」的日子永远轮不到她复盘——
   *     而这恰恰是她最该记住的那天
   *
   * 最后一道门是模型自己的：`<<skip>>` 是**正常结局**，不是失败。
   *
   * 素材只取 `role='bot'` 的行和被纠正的时刻：自述不是复盘，
   * 把对方说的话也塞进去，写出来必然是第二份日记摘要。
   */
  async function writeSelf({ day, rows }) {
    const said = rows
      .filter((r) => r.role === 'bot' && r.kind === 'chat')
      .map((r) => ({ text: String(r.text || '').slice(0, 60), at: r.at }));
    const corrected = rows
      .filter((r) => r.role !== 'bot' && RE_CORRECTION.test(String(r.text || '')))
      .map((r) => ({ text: String(r.text || '').slice(0, 80), at: r.at }));

    // 一句没说就没有「关于她自己」的素材，被纠正也无从谈起
    if (!said.length) return { written: false, why: '她这天没说话' };
    if (said.length < MIN_BOT_LINES && !corrected.length) {
      return { written: false, why: `只说了 ${said.length} 条、也没被纠正，不值得写` };
    }

    /**
     * 截断是刻意的：她说的话取最近 20 条、被纠正最多 6 条。
     * 给多了模型会写成「今天聊了 A、B、C」的流水账——那是 digest 的活。
     */
    const raw = await generate(
      buildSelfPrompt({ day, said: said.slice(-20), corrected: corrected.slice(-6) }),
    );
    const text = String(raw ?? '').trim();
    if (!text || /<<\s*skip\s*>>/i.test(text)) {
      return { written: false, why: '她自己觉得没什么可写的' };
    }

    // 标记和包裹的引号摘干净：自述是要注入提示词的，带 `<<x>>` 会漏给模型
    const clean = text
      .replace(/<<[^>]*>>/g, '')
      .replace(/^["「『]|["」』]$/g, '')
      .trim();
    if (!clean) return { written: false, why: '去掉标记后没内容' };

    self.add({ text: clean.slice(0, 200), day, at: rows[rows.length - 1].at });
    log(`写了自述（${day}）：${clean.slice(0, 40)}`);
    return { written: true };
  }

  /**
   * 把模型的"建议"落到库里。
   *
   * 每条建议都要能被拒绝：id 对不上就跳过、等级非法就跳过、
   * critical 降级由 journal.setLevel 那道护栏挡掉。**宁可少改。**
   */
  function apply({ day, chatId, list, plan, dry }) {
    const out = { ranked: 0, compressed: 0, triples: 0, agreements: 0, closed: 0, digests: 0, suppressed: 0 };
    const byId = new Map(list.map((r) => [r.id, r]));
    const at = list.length ? list[list.length - 1].at : now();

    /* 1. 等级复核 */
    const ranks = Array.isArray(plan?.ranks) ? plan.ranks : [];
    let changed = 0;
    for (const item of ranks) {
      if (changed >= MAX_RANK_CHANGES) break;
      const [id, level] = Array.isArray(item) ? item : [item?.id, item?.level];
      const row = byId.get(String(id ?? ''));
      if (!row || !['critical', 'important', 'normal'].includes(level)) continue;
      if (row.level === level) continue;
      if (dry) {
        out.ranked += 1;
        changed += 1;
        continue;
      }
      // critical → 别的等级，这里会返回 false（护栏在 journal 里）
      if (journal.setLevel(row.id, level)) {
        out.ranked += 1;
        changed += 1;
      }
    }

    /* 2. 压缩：模型点名的 + 自己到期的 */
    const plans = Array.isArray(plan?.compress) ? plan.compress : [];
    const seen = new Set();
    for (const item of plans) {
      const id = String(item?.id ?? '');
      const digest = String(item?.digest ?? '').trim();
      if (!id || !digest || seen.has(id)) continue;
      const row = byId.get(id);
      if (!row || row.level === 'critical') continue;
      seen.add(id);
      if (dry) {
        out.compressed += 1;
        continue;
      }
      if (journal.compress(id, digest)) out.compressed += 1;
    }
    /**
     * "到期自动压"**不在这里做了**。
     *
     * 原来这段在 `apply()` 里，而 `apply()` 是**按会话**调用的——
     * 3 个群就扫 3 遍全库（每遍 5000 行全文）。更要紧的是它挂在 `run(day)` 上：
     * `dueDay()` 只在"昨天有日记"时才跑，没人说话的日子积压就停在那儿。
     *
     * 现在由 `compressDue()` 独立跑（宿主每 10 分钟一轮），与按天摘要解耦。
     * 模型在这里点名的条目照旧压（上面那段），两件事互不影响。
     */

    /* 3. 三元组 → 图谱（先落 episode，抽错能重建） */
    const triples = Array.isArray(plan?.triples) ? plan.triples : [];
    if (triples.length && graph?.enabled?.() && !dry) {
      const ep = graph.addEpisode({
        at,
        chatId,
        text: `[${day}] ` + list.slice(0, 12).map((r) => r.text).join(' / ').slice(0, 1200),
        journalId: list[0]?.id ?? null,
      });
      for (const tr of triples) {
        const s = String(tr?.s ?? '').trim();
        const rel = String(tr?.rel ?? '').trim();
        const o = String(tr?.o ?? '').trim();
        if (!s || !rel || !o) continue;
        // scope=global 的边挂在跨群，chat 的只挂这个群
        const scope = String(tr?.scope ?? 'chat') === 'global' ? '' : chatId;
        /**
         * 改主意靠模型给 `op`，不再靠"关系名里有没有'住'字"这种正则。
         * 「我搬到上海了」不含"住/在"，正则漏判 → 两条"住在"并存，
         * 问"现在住哪"两个都返回。
         *
         * 护栏：`update` 只有在**确实存在同名活边**时才作废旧值；
         * 没有活边就退化成 add —— 宁可多留一条，也不要因为模型多写一个
         * `update` 把唯一那条事实关掉。
         */
        const op = String(tr?.op ?? '').toLowerCase();
        if (op === 'invalidate') {
          if (graph.closeEdge({ src: s, rel, dst: o, at, chatId: scope })) out.closed += 1;
          continue;
        }
        /**
         * 用户删过的关系**不许再写回来**。
         *
         * 这是墓碑真正生效的地方：`graph.suppressEdge` 只是删了行并记了一笔，
         * 如果这里不问一句，下一次巩固会把同一件事从日记里重新抽出来——
         * 用户会看到"删了又长回来"，那比删不掉更让人火大。
         *
         * 查的是 `scope`：删的时候选了"只删这个会话"，那别的会话照样能写；
         * 选的是全局，`chat_id=''` 的墓碑对所有会话都命中。
         */
        if (graph.isSuppressed?.({ src: s, rel, dst: o, chatId: scope })) {
          out.suppressed += 1;
          continue;
        }
        if (op === 'update' && graph.hasActive?.(s, rel, { chatId: scope })) {
          graph.closeEdge({ src: s, rel, at, chatId: scope });
        }
        if (graph.addEdge({ src: s, rel, dst: o, at, chatId: scope, episodeId: ep })) out.triples += 1;
      }
    } else if (dry) {
      out.triples += triples.length;
    }

    /* 4. 约定 → 长期事实（**按会话**，并且图里留一条活边，办完关掉） */
    const agreements = Array.isArray(plan?.agreements) ? plan.agreements : [];
    for (const a of agreements) {
      const text = String(a ?? '').trim();
      if (!text) continue;
      if (dry) {
        out.agreements += 1;
        continue;
      }
      /**
       * 约定也有墓碑。删掉的那条如果又从日记里被抽出来，
       * 会同时污染 facts 和图谱两个地方，所以两边都得先问一句。
       */
      if (graph?.isSuppressed?.({ src: '主人', rel: '约定', dst: text.slice(0, 40), chatId })) {
        out.suppressed += 1;
        continue;
      }
      /**
       * 约定**不能跨群**，这条以前是错的。
       *
       * 原来写死 `scope='global'` + `chatId: ''`，于是群里的约定
       * （「替某人喊话给某个群」「群主要求用 Markdown 回复」）会出现在
       * **每一个**会话里——包括私聊主动搭话的提示词。实际后果是模型
       * 在私聊里对着「替 X 喊话 Y」这种只有群里才有意义的事做决策，
       * 自己都觉得别扭，最后往往选择不说。
       *
       * 全局可见是有意为之的只有**身份事实**（他是谁、住在哪）；
       * 「答应过要办的事」天然属于说这句话的那个会话。
       *
       * `chatId` 为空时（老日记没有归属）退回全局：宁可放错位置，
       * 也不要因为拿不到 id 就把一条约定静默丢掉。
       */
      memory.add(chatId, `约定：${text.slice(0, 160)}`, chatId ? 'chat' : 'global');
      graph?.addEdge?.({ src: '主人', rel: '约定', dst: text.slice(0, 40), at, chatId });
      out.agreements += 1;
    }

    /* 5. 办完的约定 → 关掉活边（不删，valid_to 打上时间） */
    const closed = Array.isArray(plan?.closed) ? plan.closed : [];
    for (const c of closed) {
      const s = String(c?.s ?? '').trim();
      const rel = String(c?.rel ?? '约定').trim();
      const o = String(c?.o ?? '').trim();
      if (!s || !o) continue;
      if (dry) {
        out.closed += 1;
        continue;
      }
      /**
       * `chatId` 必须跟**建边时**一致，否则关不掉。
       *
       * 实体是**按会话**存的（`entity WHERE key=? AND chat_id=?`），
       * `closeEdge` 靠 `src_id` 定位：用 `''` 去找「主人」会拿到另一个
       * 实体行，`src_id` 对不上 → 一条都关不掉，约定永远留在"没办完"里。
       */
      out.closed += graph?.closeEdge?.({ src: s, rel, dst: o, at, chatId }) || 0;
    }

    return out;
  }

  /**
   * 过期压缩：把"到期且还没压过"的条目各压成一句。
   *
   * 为什么独立成一个节拍，而不是留在 `run(day)` 里：
   *   · `dueDay()` 的判据是"昨天有日记"，没人说话的日子它直接返回空，
   *     积压的过期条目就停在那儿没人管；
   *   · 原来它写在 `apply()` 里，而 `apply()` 是**按会话**跑的 —— N 个群扫 N 遍。
   *
   * 压的是机械摘要（本地截断 40 字），不调模型，所以每轮几百条也不花钱；
   * 压不完的下一轮接着来（取料只返回 `digest IS NULL` 的，压过的自然退出）。
   *
   * @param {{limit?: number, dry?: boolean}} [o]
   * @returns {Promise<{ok: boolean, compressed: number, due: number, remaining: number, reason?: string}>}
   */
  async function compressDue({ limit = 500, dry = false } = {}) {
    const out = { ok: true, compressed: 0, due: 0, remaining: 0 };
    try {
      const rows = journal.dueToCompress(now(), limit);
      out.due = rows.length;
      for (const row of rows) {
        if (dry) {
          out.compressed += 1;
          continue;
        }
        /** 只写 digest、不动 text —— 遗忘靠压缩，原文永远留着 */
        if (journal.compress(row.id, mechanicalDigest(row.text))) out.compressed += 1;
      }
      out.remaining = typeof journal.dueCount === 'function' ? journal.dueCount(now()) : 0;
      return out;
    } catch (e) {
      out.ok = false;
      out.reason = e?.message ?? String(e);
      log(`过期压缩失败：${out.reason}`);
      return out;
    }
  }

  /**
   * 该不该跑。
   *
   * 判定只看两件事：到了巩固点钟没有、这天的摘要存不存在。
   * **不额外存"上次跑过"的状态文件**——摘要本身就是凭据，
   * 少一个可能和真实状态不一致的地方。
   *
   * @returns {string} 要巩固的日期；不用跑就空串
   */
  function dueDay({ hour = 4, at = now() } = {}) {
    const d = new Date(at);
    if (d.getHours() < hour) return '';
    const target = yesterdayOf(at);
    const rows = journal.byDay(target);
    if (!rows.length) return '';
    const chats = new Set(rows.map((r) => r.chatId || ''));
    for (const cid of chats) if (!done(target, cid)) return target;
    return '';
  }

  return {
    run,
    /** 过期压缩（宿主每 10 分钟调一次，和按天巩固解耦） */
    compressDue,
    dueDay,
    done,
    status: () => last,
    /** 供测试注入假时钟 */
    _now: now,
  };
}
