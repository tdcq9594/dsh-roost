/**
 * 写日记
 * ======
 *
 * 从 `host.js` 拆出来的第二个域（阶段 8）。负责把「这一轮说了什么」变成一条
 * 日记，带出处（eventIds + 原文快照）。
 *
 * 依赖从参数进来：`journal`（落盘）、`memoryOff`（这个会话关没关记忆）、`log`。
 * 这样能用假 journal 验证「记了什么、什么时候不记」，不用把整个宿主拉起来。
 *
 * 批次 2 在这里多担两件事。**四处 `journalAdd` 调用全部经过这里**，
 * 放在这道共同的关口比散在 `host.js` 里改四遍稳：
 *   · 2.1 bot 行写日记前剥动作标记（派生层只收真正说出的话）；
 *   · 2.3 用户改口时作废旧约定，而不是把撤销句 append 成一条新事实。
 * 其它 `journal.add()` 调用（巩固写 digest、工具写入、开场白）不走这里，
 * 它们本来就不是对话原文，不需要这两道处理。
 */

/**
 * 撤销句式（第一道筛子）。
 *
 * 刻意收紧：只留「改口」信号，去掉了「取消 / 不许 / 不准 / 收回」这些既能
 * 表示撤销、也能表示普通陈述或**新约定**的词。独立复核实测过「取消订单」
 * 「不用了谢谢」「不许迟到」都会被宽松正则误命中，配合「不 append」会让
 * 普通消息整条丢失、还顺手作废旧记忆。
 *
 * **命中不等于撤销成立**：还必须能指向一条具体旧约定（见
 * `pickRevocationTargets`），否则按普通句正常写日记。
 */
const RE_REVOKE = /不用了|别再|不要再|不用再|以后别|别记了|不用每|作废/;

/**
 * 身份事实不受一句「不用了」影响。
 * 「我叫小明 / 我住杭州 / 生日是三月」这类 critical 是长期事实。
 */
const RE_IDENTITY = /我叫|我的名字|我姓|名字是|我住|我家在|我老家|生日是|我生日|我电话|我手机|我邮箱|我微信/;

/**
 * 纯客套不触发撤销。
 *
 * 第三轮复核 C2b：「不用了谢谢」与某条约定碰巧共享一个「谢」字，
 * 就会把那条 critical 作废。真机「你就不用了」「别再发」都不匹配这里，
 * 它们带具体指向，不是客套收尾。
 */
const RE_POLITE = /^(?:不用了|不用啦|不用了谢谢|不用，谢谢|算了不用了|不用了哈)[，。！？\s]*$/;

/**
 * 纯客套是不是「看着像改口、其实不是」。
 *
 * 导出给 `consolidate.js` 的 L3 复用：L2 在写日记时靠它避免误作废，
 * L3 取时间上界时也必须排除——否则当天更早一句「不用了谢谢」会把
 * 上界压到所有约定之前，让真正该作废的旧约定静默逃掉（00:5x 复核 P0）。
 */
export function isPoliteRevocation(text) {
  return RE_POLITE.test(String(text ?? '').trim());
}

/**
 * 动作标记：值里可能出现单个 `>`，所以不能用 `[^>]*` 截断。
 * `(?!<<)` 是逐字保护——value 不许跨过下一个 `<<`，否则嵌套
 * `<<say: <<say: x>> y>>` 的外层会一口咬到内层的 `>>`，留下 ` y>>` 残骸。
 * 加了保护后引擎从最内层起匹配，配合 cleanBotText 的逐层循环剥干净。
 *
 * 两个图片标记都要认：`<<image: 路径>>`（图文同条）与 `<<image-alone: 路径>>`
 * （单独一条）。它们都是标记、要摘，摘完补一条「发了图片」的占位。
 */
const RE_ACTION = /<<\s*(image-alone|image|voice|say|button|silence|remember)\s*(?::|：)\s*((?:(?!<<)[\s\S])*?)>>/gi;
/** 兜底只认已知动作名，避免 `a << b >> c` 这类正文被误伤 */
const RE_ANY_MARK = /<<\s*(?:image|voice|say|button|silence|remember|forget|mood)\s*(?::|：)?(?:(?!<<)[\s\S])*?>>/gi;
/**
 * 半截标记只摘到**第一个句末标点或换行**为止。
 *
 * 复核实测：用 `[\s\S]*$` 会把同一行后面的正常正文、乃至下一行整条吞掉
 * （「你好<<say: 断了，后面还有正常正文」→「你好」）。宁可留个逗号，
 * 也不能把她说过的话静默删掉。同样不许跨过下一个 `<<`。
 */
const RE_UNCLOSED = /<<\s*(?:image|voice|say|button|silence|remember|forget|mood)\s*(?::|：)?(?:(?!<<)[^，。！？\n])*/gi;

/**
 * 引用文本（L1 的输入）。
 *
 * 框架协议里有 `payload.quoted`，但 `renderInbound()` 在有 `rendered` 时
 * **直接返回整段**、不回填这个字段——引用被拼成「（引用了这句：…）」内联
 * 在文本里（§7 2.2 原本就写了这个兜底）。两条路都认，L1 才不会恒空。
 */
export function quotedOf(payload, text) {
  const direct = String(payload?.quoted ?? '').trim();
  if (direct) return direct.slice(0, 500);
  /** 「）」后必须接换行或结束：引用内容里出现全角右括号时不会被提前截断 */
  const m = String(text ?? '').match(/（引用了这句：([\s\S]*?)）\s*(?:\n|$)/);
  return m ? String(m[1]).trim().slice(0, 500) : '';
}

/** 中文单字集合（去掉空白与标点） */
function charSet(s) {
  return new Set(String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').split(''));
}
/**
 * 共享单字数，**不做归一化**。
 *
 * 二次独立复核实测：按 `min(两边字数)` 算相似度对长约定极不友好——真机
 * 19:17:20 原话「让她记住每发一句话一定要发个表情包」15 字，与
 * 「你就不用了 + 引用」只共享 3 字，得分 0.200 被 0.25 门槛挡掉，于是
 * critical 约定照样进 `top()`、P4 静默修不好。改成绝对共享字数后，
 * 「能不能指向」只取决于有没有共同字，与句子长短无关。
 */
function sharedCount(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const c of a) if (b.has(c)) n += 1;
  return n;
}

/** 这条用户消息是不是在推翻之前的约定。纯规则，零模型调用 */
export function isRevocation(text) {
  return RE_REVOKE.test(String(text ?? '').trim());
}

/**
 * 身份事实（长期、不因一句改口作废）。
 *
 * 导出给 `consolidate.js` 的 L3 候选筛子复用：`pickRevocationTargets`
 * 里用的就是这条口径，两处各写一份迟早漂移，导致 L2 不当作废的、
 * L3 反而给作废了。
 */
export function isIdentityFact(text) {
  return RE_IDENTITY.test(String(text ?? ''));
}

/**
 * bot 行写日记前的清洗（2.1）。
 *
 * 日记是派生层，只该收「她说过的话」：真机 19:17:22–19:24:11 连续 8 条
 * bot 行原样存着图片标记，模型下一轮把这些标记读成自己说过的约定。
 *
 * 有个必须补的洞（§10.5 关键 P1）：`fileNote` 只来自 `qq_send` 的
 * `fileNames`，而表情包不走那条路。剥完图片节点若什么都不补，
 * 「她发过图」这件事就彻底从记忆里消失了——用户要的是不发图，不是不记得
 * 发过图。所以剥标准图片节点 / voice 时各补一条中文占位。
 *
 * 正文里的 `![](路径)`（ai-chat 把标记转换后的形态）同理：不是 `<<>>` 标记，
 * 上面几套正则都吃不到，但里面是本地绝对路径，留在日记里会让模型下一轮
 * 把它当成自己说过的约定。一并剥掉、同样计入「发了图片」。
 *
 * 两种标记都会发图（一种是图文同条、一种是单独一条），所以都补占位。
 *
 * `<<say: 内容>>` 里的「内容」是她真的念出来的话，保留文本、只摘外壳。
 */
export function cleanBotText(text) {
  const s = String(text ?? '');
  let images = 0;
  let voices = 0;
  let out = s;
  /**
   * 嵌套标记要逐层剥：外层 value 不跨 `<<`，第一轮吃掉最内层，
   * 外层要到下一轮才成形。循环到不动点，5 轮上限防病态输入。
   * 畸形嵌套会把一个 voice 计成 ×2，真机遇不到，按「宁可多留一条痕迹」处理。
   */
  for (let round = 0; round < 5; round += 1) {
    const before = out;
    out = out.replace(RE_ACTION, (_full, name, value) => {
      const k = String(name).toLowerCase();
      const v = String(value ?? '').trim();
      if (k === 'image' || k === 'image-alone') { images += 1; return ''; }
      if (k === 'voice') { voices += 1; return ''; }
      if (k === 'say') return v;
      // button / silence / remember 都是指令，不是正文
      return '';
    });
    out = out.replace(RE_ANY_MARK, '');
    if (out === before) break;
  }
  /** 半截标记：只摘标记本身，后面的正文留着 */
  out = out.replace(RE_UNCLOSED, '');
  /**
   * 标准 markdown 图片（框架通用图文出口的新写法）。
   * 在循环外做一次，避免每轮重复计数；alt 里的 `#宽px #高px` 一起丢掉。
   */
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
    images += 1;
    return '';
  });
  const notes = [];
  if (images) notes.push(images > 1 ? `（发了图片 ×${images}）` : '（发了图片）');
  if (voices) notes.push(voices > 1 ? `（发了语音 ×${voices}）` : '（发了语音）');
  return [out.replace(/\n{3,}/g, '\n\n').trim(), ...notes].filter(Boolean).join('\n');
}

/**
 * 三级撤销的 **L1 / L2** 选目标（L3 语义兜底不在同步写日记链路，见交接文档）。
 *
 * 两轮独立复核各抓到一条 P0，这个函数是按两条结论定稿的：
 *   · 第一轮：「取最近 1 条 high 行」在约定后夹了别的 important 时会作废错行；
 *   · 第二轮：归一化相似度 + 0.25 门槛，让真机 15 字长约定静默不撤销。
 *
 * 现在的判据**全部是确定性的、与句子长短无关**：
 *   1. 候选只收 `critical`/`important`、未失效、本轮之前的 user 行；身份事实、
 *      以及**本身就是改口句**的行（「别再发表情包了，配表情包没有意思」这类
 *      回声）都不参与，避免它靠字面重合击败真约定。
 *   2. L1 有引用 → 用引用文本与 bot 行算共享字数，选最像的当 anchor，候选缩到
 *      anchor 之前。精确包含额外加权，短引用也能定位。
 *   3. L2 无引用 → 全部候选参与。
 *   4. 排序：`critical` 优先 → 共享字数多 → 时间新。真机约定是 critical，
 *      夹在中间的「明天提醒我买牛奶」是 important，稳稳选中前者。
 *   5. 至少要共享 1 个字才算「指得出旧约定」；但 **L1 已定位到 anchor 时给保底**
 *      （引用本身就是用户明确指着旧约定改口的强信号）。
 *      「不用了谢谢」既无引用又无共享字 → 返回空 → 按普通句写日记，不丢消息。
 *
 * L1 命中时顺带作废被引用、且本身也是 high-level 的 bot 行（约定的回声）。
 *
 * @param {Array} rows `journal.listChat(chatId, 0, aliases)` 的结果（已过滤失效行）
 * @returns {{ids:string[], level:'L1'|'L2'|null}}
 */
export function pickRevocationTargets(rows, { quoted = '', text = '', before = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const at = Number(before) || Date.now();
  const q = String(quoted ?? '').trim().slice(0, 500);
  const qChars = charSet(`${text} ${q}`);

  const high = list.filter(
    (r) =>
      (r.level === 'critical' || r.level === 'important')
      && Number(r.invalidAt ?? 0) === 0
      && Number(r.at ?? 0) < at
      && String(r.role ?? 'user') === 'user'
      && !RE_IDENTITY.test(String(r.text ?? ''))
      && !RE_REVOKE.test(String(r.text ?? '')),
  );
  if (!high.length) return { ids: [], level: null };

  /** L1：用引用文本挑最像的 bot 行，而不是在倒序结果里 find 第一条 */
  let anchor = null;
  if (q) {
    const qc = charSet(q);
    const bots = list
      .filter((r) => String(r.role ?? '') === 'bot' && Number(r.at ?? 0) < at)
      .map((r) => {
        const t = String(r.text ?? '');
        return {
          r,
          score: sharedCount(qc, charSet(t)) + (t.includes(q) || q.includes(t) ? 100 : 0),
        };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || Number(b.r.at) - Number(a.r.at));
    anchor = bots[0]?.r ?? null;
  }

  const pool = anchor ? high.filter((r) => Number(r.at) <= Number(anchor.at)) : high;
  const scored = (pool.length ? pool : high).map((r) => ({
    r,
    shared: sharedCount(qChars, charSet(r.text)),
    critical: r.level === 'critical' ? 1 : 0,
  }));
  /** 无引用且一个共同字都没有 = 指不出旧约定 */
  const usable = scored.filter((x) => x.shared >= 1);
  /**
   * L1 保底要再过一道相关性校验：anchor 必须和候选真的有共同字。
   *
   * 否则「撤销词 + 引用了一条无关的 bot 行」（例如引用「嗯嗯，收到啦」）
   * 会无条件作废最优先的 critical 约定——第三轮复核 C1b 实测的静默误伤。
   * 真机短引用「好呀」仍能过：被引 bot 行与约定共享「每 / 话」。
   */
  const fallback = anchor
    ? scored.filter(
        (x) => sharedCount(charSet(String(anchor.text ?? '')), charSet(String(x.r.text ?? ''))) >= 1,
      )
    : [];
  const candidates = usable.length ? usable : fallback;
  const best = candidates.sort(
    (a, b) => b.critical - a.critical || b.shared - a.shared || Number(b.r.at) - Number(a.r.at),
  )[0];
  if (!best) return { ids: [], level: null };

  const ids = [String(best.r.id)];
  if (
    anchor
    && (anchor.level === 'critical' || anchor.level === 'important')
    && Number(anchor.invalidAt ?? 0) === 0
    && !ids.includes(String(anchor.id))
  ) ids.push(String(anchor.id));
  /**
   * L2（无引用）也作废与约定字面重合的 high-level bot 回声。
   * 沿用 L1 的四重护栏（高等级 / 未失效 / 早于改口 / 共享 ≥2 字），
   * 阈值不取 1，避免第三轮复核抓到的「一个共享字误作废」复发。
   */
  if (!anchor) {
    const echo = list.find(
      (r) =>
        String(r.role ?? '') === 'bot'
        && (r.level === 'critical' || r.level === 'important')
        && Number(r.invalidAt ?? 0) === 0
        && Number(r.at ?? 0) < at
        && sharedCount(charSet(String(best.r.text ?? '')), charSet(String(r.text ?? ''))) >= 2
        && !ids.includes(String(r.id)),
    );
    if (echo) ids.push(String(echo.id));
  }
  return { ids, level: anchor ? 'L1' : 'L2' };
}

/**
 * @param {{journal:object, memoryOff:(chatId:string)=>boolean, log:object}} deps
 */
export function createJournalBridge({ journal, memoryOff, log }) {
  /**
   * @param {object} [opts] `kind` 默认 'chat'（对话原文）。主动搭话传 'proactive'：
   *   C1 防复读要能看到它，但凌晨巩固只取 `kind==='chat'`，不该把主动话
   *   当对话素材提炼成事实/摘要。
   */
  function add(payload, chat, text, role, { kind = 'chat' } = {}) {
    if (memoryOff(chat?.chatId)) return;
    try {
      const base = String(payload?.id ?? '').trim();
      /**
       * 这一轮对应事件账本里的哪几条（场景片段，阶段 4）。
       *
       * 合并窗口攒过几句时是多条——一批消息合成一轮对话，出处也该是这一批。
       * 没开事件账本时这个数组是空的，日记照写，只是以后查不回原文。
       */
      const eventIds = (Array.isArray(payload?.eventIds) ? payload.eventIds : [])
        .map(String)
        .filter(Boolean);

      /** 2.1：bot 行的动作标记不带进日记；剥完没内容就不写空行 */
      const body = role === 'bot' ? cleanBotText(text) : String(text ?? '');
      if (!body.trim()) return;

      /**
       * 2.3：撤销句不作新事实 append。
       *
       * 真机 P4 的根因就是「别再发」被当成一条新的 `normal` 事实，而
       * 19:17:20 那条 `critical` 约定还挂着，两条并存、模型夹在中间。
       * 这里改成作废旧约定，并把本条消息 id 写进失效行的 `superseded_by`
       * ——溯源靠它，不靠再写一条日记（验收原话：带 `superseded_by` 指向
       * 19:17:42）。原始消息本身仍在框架 `events.db` 里。
       *
       * **只有真的作废了东西才 `return`**：指不出旧约定的「不用了谢谢」
       * 必须按普通句写进日记，不能静默丢消息。
       *
       * 假 journal（单测）没有 `invalidate` 时安静跳过判定，保持老行为。
       */
      if (
        role === 'user'
        && isRevocation(text)
        && !RE_POLITE.test(String(text ?? '').trim())
        && typeof journal.invalidate === 'function'
      ) {
        /** 别名键要传：换过机器人之后旧约定挂在旧 openid 下，注入读得到、撤销也得读得到 */
        const aliases = Array.isArray(chat?.aliases) ? chat.aliases : [];
        const rows = typeof journal.listChat === 'function'
          ? (journal.listChat(chat?.chatId, 0, aliases) || [])
          : typeof journal.recent === 'function'
            ? (journal.recent(chat?.chatId, 500) || [])
            : [];
        const picked = pickRevocationTargets(rows, {
          quoted: quotedOf(payload, text),
          text: String(text ?? ''),
          /** 用本轮写入时刻，别依赖 payload.at（生产里可能没有或早于写入） */
          before: Date.now(),
        });
        if (picked.ids.length) {
          const n = journal.invalidate(picked.ids, { at: Date.now(), supersededBy: base });
          if (n) {
            log?.info?.(`记忆撤销（${picked.level}）：作废 ${n} 条旧约定`);
            return;
          }
        }
      }

      journal.add({
        // 没有 msg_id 时给空串，journal 内部会生成随机 id（宁可重复也不丢）
        id: base ? `${base}${role === 'bot' ? ':bot' : ''}` : '',
        at: Date.now(),
        chatId: chat.chatId,
        sender: role === 'bot' ? '' : String(payload?.sender?.name ?? '').trim(),
        role,
        kind,
        text: body,
        eventIds,
        /**
         * 原文快照。**存的是整段，不是逐条**——合并批的正文已经被拼成一段，
         * 拆不回原来那几条。快照的用途是「events 按保留策略滚动删了还能看到
         * 当时说了什么」，整段正好满足；要逐条回看原文，用 `eventIds` 调
         * `/r/context`。这里同样用清洗后的 `body`，别把动作标记抄进快照。
         */
        evidence: eventIds.length
          ? [{
              eventId: eventIds[eventIds.length - 1],
              at: Date.now(),
              sender: role === 'bot' ? 'bot' : String(payload?.sender?.name ?? '').trim(),
              excerpt: body.slice(0, 200),
            }]
          : [],
      });
    } catch (e) {
      log.warn(`日记没写进去（不影响这轮）：${e.message}`);
    }
  }

  return { add };
}
