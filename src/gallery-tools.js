/**
 * 图库工具：让模型**自己**看有哪些图、自己往里存、自己改标注。
 *
 * 和 `sticker-tools.js` 的分工：
 *   · `sticker_pick` 是「按分类拿路径」——面向文件系统的旧形态，路径交给模型；
 *   · 这几个是「按序号办事」——**模型从头到尾看不到路径和 URL**，
 *     发图只写 `<<image: #3>>`，宿主自己换。
 *
 * 为什么非要序号：`D:\表情\开心\熊猫大笑 (2).png` 抄错一个字符就是图发不出去，
 * 而界面上完全看不出发生过什么；`#3` 抄不错，出错还能明确报「3 号没有」。
 *
 * ## 谁能用
 *
 * `gallery_save / edit / remove` **只给主人**（`callerOf().bucket === 'owner'`），
 * 理由和 `memory_note` 一样：图库是全群共享的资产品味，谁都能改就等于谁都能
 * 往里塞东西。`gallery_list` 谁都能看——它只读、也不带路径。
 * `gallery_show` 给主人 + 管理员：它不动数据，但**每次都要花一次模型调用**
 * （或把一张图塞进上下文），群友随手点几下就是钱。
 *
 * 注意 `bucket === 'owner'` 在主人所在的群里同样成立，所以这里判的是「这个
 * 人是不是主人」，不是「这是不是私聊」。群友档拿不到写工具，execute 里再验一次
 * （纵深防御：工具注册万一被别的路径绕过，这里还挡着）。
 */

import { loadDefineTool, shapeTool } from './tools.js';

/** 写操作的最小档位。`admin` 不算——它不是「主人本人」 */
const canWrite = (callerOf) => {
  try {
    return String(callerOf?.()?.bucket ?? '') === 'owner';
  } catch {
    /** 取不到身份就按「不是主人」处理。宁可少一个能力，不能多开一道门 */
    return false;
  }
};

/** 看图是花钱的读操作，放给主人 + 管理员 */
const canView = (callerOf) => {
  try {
    const b = String(callerOf?.()?.bucket ?? '');
    return b === 'owner' || b === 'admin';
  } catch {
    return false;
  }
};

/**
 * 一轮最多看几张。
 *
 * 不是为了省钱（虽然确实省），主要是**防止它在图库上来回翻**：模型一旦开始
 * 「一张张确认」，很容易连着看十几张，把上下文塞满、还答不出原来那个问题。
 * 两张足够分辨「这两张哪张合适」，再多就该用 `gallery_list` 的描述去筛。
 */
export const MAX_SHOW_PER_TURN = 2;

const DENY = { ok: false, message: '这个操作只对主人开放（改图库会影响所有人看到的图）' };
const DENY_VIEW = { ok: false, message: '看图要花一次模型调用，只对主人和管理员开放' };

/**
 * @param {object} o
 * @param {(o:object)=>object} o.listOf
 * @param {(o:object)=>object} o.saveOf
 * @param {(seq:number, patch:object)=>object} o.editOf
 * @param {(seq:number)=>object} o.removeOf
 * @param {(o:{seq:number, ask:string})=>Promise<object>} [o.showOf] 看一张图；不传就没有 `gallery_show`
 * @param {() => string} [o.turnKeyOf] 当前轮次的键，用来算「这一轮看了几张」
 * @param {() => {bucket?:string}} [o.callerOf]
 */
export function buildGalleryToolDefs({
  listOf, saveOf, editOf, removeOf, showOf = null, turnKeyOf = () => '', callerOf = () => ({}),
}) {
  /** 序号参数一律按字符串收（见 `sticker-tools.js` 里 `n` 的说明） */
  const seqOf = (v) => {
    const n = Number.parseInt(String(v ?? '').replace(/^#/, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /**
   * 这一轮看了几张。
   *
   * `turnKeyOf` 给不出来（老宿主 / 独立会话）时退到「按分钟」——不是为了准确，
   * 只是别让限制变成「整个进程一辈子 2 张」。键上限 200 条，超了整表清空：
   * 这个计数丢了最多让它多看一张，不值得写淘汰策略。
   */
  const showCount = new Map();
  const takeShow = () => {
    let key = '';
    try {
      key = String(turnKeyOf?.() || '');
    } catch { key = ''; }
    if (!key) key = `min:${Math.floor(Date.now() / 60_000)}`;
    const n = (showCount.get(key) || 0) + 1;
    if (showCount.size > 200) showCount.clear();
    showCount.set(key, n);
    return n <= MAX_SHOW_PER_TURN;
  };

  const list = {
    name: 'gallery_list',
    description:
      '看你的图库里有哪些图。每行是「#序号  文件名  原图宽×高  描述」，序号就是发图时要写的。'
      + '想知道有哪些图、各是什么用、什么时候该发、该避开什么场合，都看这里；'
      + '文件名后面那个「宽×高」是原图尺寸，发图时据此决定放多大。'
      + '要发图时写 `<<image: #序号>>`（图和文字同一条）或 `<<image-alone: #序号>>`（单独一条），'
      + '末尾可以加 `|宽x高` 指定显示大小，比如 `<<image: #3|320x>>`（只给宽，高按原图比例自动算）、'
      + '`<<image: #3|320x200>>`（两个都给，可以放大缩小甚至变形）。'
      + '`<<image:>>` 是**行内插入**：图不另起一行，但它的高度会撑开这一行，'
      + '想让它和文字齐平就像小表情一样，写 `|x14`（约等于一行汉字高；参考值，可微调）。'
      + '**图库里的图只写序号，不要自己拼路径**（真路径宿主会换）；'
      + '要发系统上的其它文件（报表、截图）就直接写路径，那条路也认。'
      + '要确认某一张的具体画面（图里有没有字、表情什么样子）用 gallery_show。',
    parameters: {
      cat: {
        type: 'string',
        description: '只看某个分类，比如「开心」。不确定有哪些分类就留空，返回里会列出全部分类。',
      },
      n: {
        type: 'string',
        description: '要列几条，默认 30，最多 60。图很多时它只列最常用的那些。',
      },
      fresh: {
        type: 'string',
        description: '填 "1" 只看从来没用过的图（想找点新鲜的时用）。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /**
       * **只把清单文本交给模型**，不交 items 数组。
       *
       * 同一份信息用 JSON 表示会多出几百个 token 的括号和引号，而模型读
       * 「一行一张图」这种排版的准确率更高。
       */
      render: (_a, value) => [{ type: 'text', text: String(value?.text ?? '（图库是空的）') }],
    },
    async execute({ cat, n, fresh } = {}) {
      try {
        const r = listOf({ cat, n, fresh });
        return { ok: r?.ok !== false, text: r?.text ?? '', total: r?.total ?? 0 };
      } catch (e) {
        return { ok: false, text: `看图库失败：${e?.message ?? e}` };
      }
    },
  };

  /**
   * 看一张具体的图。
   *
   * **这一条真的会把图给模型看。**
   *
   * 有两条实现路径，选哪条由宿主决定（`showOf` 里判当前模型能不能收图）：
   *   · 能收图：把图登记成附件引用塞进工具结果，模型直接看到像素；
   *   · 不能收图：调视觉模型代看，把回答带回来。
   * 工具层不关心走了哪条，只负责把 `blocks` 原样放进返回内容——`blocks` 里
   * 是**已登记的附件引用**（不是 base64），所以不会被工具输出的 4 KB 预算剥掉。
   */
  const show = showOf
    ? {
      name: 'gallery_show',
      description:
        '看一张具体的图。它会把这张图真的给你看，你可以直接回答关于画面的问题。'
        + '不确定某张图画了什么、想确认细节（图里有没有字、什么表情、什么颜色）时用它；'
        + '只想浏览有哪些图用 gallery_list，别一张张 show——那是花钱的，一轮最多看 '
        + `${MAX_SHOW_PER_TURN} 张。`,
      parameters: {
        seq: { type: 'string', required: true, description: '要看的序号，比如 3 或 #3' },
        ask: { type: 'string', description: '想问这张图什么（比如「图里有没有文字」）。不填就让它描述画面' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        /**
         * 文字在前、图片块在后。
         *
         * 图片块已经是**登记过的引用**（`{type:'image', attachment:{…}}`），
         * DSH 的适配层认这个形状，并且明确支持工具结果里带图
         * （`dsh-llm-deepseek/src/images.ts`：「supports images only in user
         * messages and tool results」）。**不能塞 base64**——那个形状只在
         * 「提交用户消息」那一步有效，塞进工具结果里适配层读不到。
         */
        render: (_a, v) => {
          const text = String(v?.text ?? (v?.ok === false ? (v?.message ?? '看不了这张图') : ''));
          const blocks = Array.isArray(v?.blocks) ? v.blocks : [];
          return [{ type: 'text', text }, ...blocks];
        },
      },
      async execute({ seq, ask } = {}) {
        if (!canView(callerOf)) return DENY_VIEW;
        const n = seqOf(seq);
        if (!n) return { ok: false, message: '要给一个序号，比如 3' };
        if (!takeShow()) {
          return { ok: false, message: `这一轮已经看过 ${MAX_SHOW_PER_TURN} 张了，够判断了——用看到的东西回答，别再一张张翻。` };
        }
        try {
          const r = await showOf({ seq: n, ask: String(ask ?? '').slice(0, 200) });
          if (!r?.ok) return { ok: false, message: r?.message ?? '看不了这张图' };
          return {
            ok: true,
            seq: n,
            text: String(r.text ?? ''),
            /** 有图就带上；没有就是纯文字（视觉模型代看那条路） */
            ...(Array.isArray(r.blocks) && r.blocks.length ? { blocks: r.blocks } : {}),
            /** 顺手给的标注建议，想用就自己调 gallery_edit 写进去 */
            ...(r.suggest ? { suggest: r.suggest } : {}),
          };
        } catch (e) {
          return { ok: false, message: `看图失败：${e?.message ?? e}` };
        }
      },
    }
    : null;

  const save = {
    name: 'gallery_save',
    description:
      '把一张图存进你的图库，会给它一个新序号。'
      + 'from="last" 表示存刚收到的那张图；也可以写一个本地文件路径，或者一个 http(s) 图片网址。'
      + '存之前可以顺手给个名字和「什么场合用」，以后自己好找。'
      + '同一张图重复存不会多出第二条，会告诉你原来的序号。',
    parameters: {
      from: {
        type: 'string',
        required: true,
        description: '图从哪来：last（刚才那条消息里的图）、本地文件路径、或 http(s) 图片网址',
      },
      name: { type: 'string', description: '给它起个短名字，比如「熊猫大笑」，10 字以内' },
      meaning: { type: 'string', description: '这张图画的是什么、什么感觉，一句话' },
      cat: { type: 'string', description: '放进哪个分类，比如「开心」。留空就是未分类' },
      tags: { type: 'string', description: '几个关键词，用顿号或逗号隔开' },
      scenes: { type: 'string', description: '什么场合适合发它' },
      avoid: { type: 'string', description: '什么场合别发它' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null, null, 0) }],
    },
    async execute(args = {}) {
      if (!canWrite(callerOf)) return DENY;
      try {
        /** `await`：网址那条路要先下载（宿主负责），本地路径那条是同步返回 */
        const r = await saveOf({
          from: args.from, name: args.name, meaning: args.meaning, cat: args.cat,
          tags: args.tags, scenes: args.scenes, avoid: args.avoid,
        });
        /** 工具结果里不能带 path：这是「不给链接」的底线 */
        return r?.ok
          ? { ok: true, seq: r.seq, dup: r.dup === true, file: r.item?.file, message: r.message ?? '' }
          : { ok: false, message: r?.message ?? '存不进去' };
      } catch (e) {
        return { ok: false, message: `存图失败：${e?.message ?? e}` };
      }
    },
  };

  const edit = {
    name: 'gallery_edit',
    description:
      '改一张图的标注：名字、含义、关键词、适合的场合、要避开的场合、分类，'
      + '或者「暂时不用」（enabled）和「固定」（pinned）。'
      + '整理图库时用——把「未标注」的补上，把放错分类的挪过去。只改你给的那几个字段，别的不动。'
      + '固定 = 官方素材池配额满时不会被自动淘汰；常用的图值得固定。',
    parameters: {
      seq: { type: 'string', required: true, description: '要改的序号，比如 3 或 #3' },
      name: { type: 'string', description: '短名字，10 字以内' },
      meaning: { type: 'string', description: '这张图画的是什么、什么感觉' },
      tags: { type: 'string', description: '关键词，顿号或逗号隔开，最多 6 个' },
      scenes: { type: 'string', description: '什么场合适合发' },
      avoid: { type: 'string', description: '什么场合别发' },
      cat: { type: 'string', description: '分类名。给空串表示挪回未分类' },
      enabled: { type: 'string', description: '填 "0" 表示暂时不用这张（不删）' },
      pinned: {
        type: 'string',
        description: '填 "1" 固定这张（官方素材池配额满时不会被自动淘汰）；"0" 取消固定。'
          + '常用的图（招牌表情、口头禅）值得固定，被淘汰了下次发要重传',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null, null, 0) }],
    },
    async execute(args = {}) {
      if (!canWrite(callerOf)) return DENY;
      const seq = seqOf(args.seq);
      if (!seq) return { ok: false, message: '要给一个序号，比如 3' };
      const patch = {};
      for (const k of ['name', 'meaning', 'tags', 'scenes', 'avoid', 'cat']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.enabled !== undefined) patch.enabled = String(args.enabled) !== '0';
      if (args.pinned !== undefined) patch.pinned = String(args.pinned) === '1';
      if (!Object.keys(patch).length) return { ok: false, message: '没说要改什么' };
      try {
        const r = editOf(seq, patch);
        return r?.ok
          ? { ok: true, seq, item: r.item }
          : { ok: false, message: r?.message ?? '改不了' };
      } catch (e) {
        return { ok: false, message: `改标注失败：${e?.message ?? e}` };
      }
    },
  };

  const remove = {
    name: 'gallery_remove',
    description:
      '把一张图从图库里撤下来（进回收站，文件不会被删，序号也不会被别人占了）。'
      + '发错分类、重复的、质量太差的图用它。只是不想用某一张时优先用 gallery_edit 的 enabled=0。',
    parameters: {
      seq: { type: 'string', required: true, description: '要撤下的序号' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null, null, 0) }],
    },
    async execute({ seq } = {}) {
      if (!canWrite(callerOf)) return DENY;
      const n = seqOf(seq);
      if (!n) return { ok: false, message: '要给一个序号' };
      try {
        const r = removeOf(n);
        return r?.ok
          ? { ok: true, seq: n, message: '已移入回收站（文件还在，可以恢复）' }
          : { ok: false, message: r?.message ?? '撤不下来' };
      } catch (e) {
        return { ok: false, message: `撤下失败：${e?.message ?? e}` };
      }
    },
  };

  /** `show` 要宿主给了 `showOf` 才挂——没有视觉能力时不留一个永远失败的按钮 */
  return [list, ...(show ? [show] : []), save, edit, remove];
}

/**
 * 挂到 agent 上。失败不抛错，把原因带出去让面板显示。
 *
 * 和 `registerStickerTools` 一样的三级降级：真 `defineTool` → 普通对象 → 明确记日志。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerGalleryTools({
  agent, listOf, saveOf, editOf, removeOf, showOf = null, turnKeyOf = () => '', callerOf, log = () => {},
}) {
  const defs = buildGalleryToolDefs({ listOf, saveOf, editOf, removeOf, showOf, turnKeyOf, callerOf });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }

  const defineTool = await loadDefineTool();
  const made = [];
  for (const def of defs) {
    try {
      made.push({ off: registry.register(shapeTool(def, defineTool)), name: def.name });
    } catch (e) {
      log(`图库工具 ${def.name} 没装上：${e.message}`);
      return {
        ok: false,
        names: made.map((m) => m.name),
        reason: `${def.name} 注册失败：${e.message}${defineTool ? '' : '（拿不到 @deepseek-ai/dsh-tools，交的是普通对象）'}`,
      };
    }
  }
  return {
    ok: true,
    names: made.map((m) => m.name),
    mode: defineTool ? 'defineTool' : 'plain',
    off: () => {
      for (const m of made) {
        try { m.off?.(); } catch {}
      }
    },
  };
}
