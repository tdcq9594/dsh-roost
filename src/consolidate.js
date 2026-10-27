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
 * @param {object} o
 * @param {object} o.journal  createJournal() 的返回
 * @param {object} o.graph    createGraph() 的返回
 * @param {object} o.memory   createMemory() 的返回（约定要沉进 facts）
 * @param {(p:string)=>Promise<string>} [o.generate] 没给就只做机械压缩
 */
export function createConsolidate({ journal, graph, memory, generate = null, log = () => {}, now = () => Date.now() } = {}) {
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
        for (const k of ['ranked', 'compressed', 'triples', 'agreements', 'closed', 'digests']) {
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
   * 把模型的"建议"落到库里。
   *
   * 每条建议都要能被拒绝：id 对不上就跳过、等级非法就跳过、
   * critical 降级由 journal.setLevel 那道护栏挡掉。**宁可少改。**
   */
  function apply({ day, chatId, list, plan, dry }) {
    const out = { ranked: 0, compressed: 0, triples: 0, agreements: 0, closed: 0, digests: 0 };
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
    // 到期的（模型没点名也要压，否则"普通条目几天后消失"这条就落不了地）
    // 注意这里要比的是"现在"，不是昨天最后一条消息的时间——
    // 否则 23:00 之后到期的那批要等到明天凌晨才被处理。
    for (const row of journal.dueToCompress(now())) {
      if (seen.has(row.id) || row.level === 'critical') continue;
      if (dry) {
        out.compressed += 1;
        continue;
      }
      if (journal.compress(row.id, mechanicalDigest(row.text))) out.compressed += 1;
    }

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
        if (op === 'update' && graph.hasActive?.(s, rel, { chatId: scope })) {
          graph.closeEdge({ src: s, rel, at, chatId: scope });
        }
        if (graph.addEdge({ src: s, rel, dst: o, at, chatId: scope, episodeId: ep })) out.triples += 1;
      }
    } else if (dry) {
      out.triples += triples.length;
    }

    /* 4. 约定 → 长期事实（跨群，并且图里留一条活边，办完关掉） */
    const agreements = Array.isArray(plan?.agreements) ? plan.agreements : [];
    for (const a of agreements) {
      const text = String(a ?? '').trim();
      if (!text) continue;
      if (dry) {
        out.agreements += 1;
        continue;
      }
      memory.add(chatId, `约定：${text.slice(0, 160)}`, 'global');
      graph?.addEdge?.({ src: '主人', rel: '约定', dst: text.slice(0, 40), at, chatId: '' });
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
      out.closed += graph?.closeEdge?.({ src: s, rel, dst: o, at, chatId: '' }) || 0;
    }

    return out;
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
    dueDay,
    done,
    status: () => last,
    /** 供测试注入假时钟 */
    _now: now,
  };
}
