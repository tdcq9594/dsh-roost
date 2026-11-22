/**
 * 图库工具：让模型**自己**看有哪些图、自己往里存、自己改标注。
 *
 * 和 `sticker-tools.js` 的分工：
 *   · `sticker_pick` 是「按分类拿路径」——面向文件系统的旧形态，路径交给模型；
 *   · 这四个是「按序号办事」——**模型从头到尾看不到路径和 URL**，
 *     发图只写 `<<image: #3>>`，宿主自己换。
 *
 * 为什么非要序号：`D:\表情\开心\熊猫大笑 (2).png` 抄错一个字符就是图发不出去，
 * 而界面上完全看不出发生过什么；`#3` 抄不错，出错还能明确报「3 号没有」。
 *
 * ## 谁能写
 *
 * `gallery_save / edit / remove` **只给主人**（`callerOf().bucket === 'owner'`），
 * 理由和 `memory_note` 一样：图库是全群共享的资产品味，谁都能改就等于谁都能
 * 往里塞东西。`gallery_list` 谁都能看——它只读、也不带路径。
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

const DENY = { ok: false, message: '这个操作只对主人开放（改图库会影响所有人看到的图）' };

/**
 * @param {object} o
 * @param {(o:object)=>object} o.listOf
 * @param {(o:object)=>object} o.saveOf
 * @param {(seq:number, patch:object)=>object} o.editOf
 * @param {(seq:number)=>object} o.removeOf
 * @param {() => {bucket?:string}} [o.callerOf]
 */
export function buildGalleryToolDefs({ listOf, saveOf, editOf, removeOf, callerOf = () => ({}) }) {
  /** 序号参数一律按字符串收（见 `sticker-tools.js` 里 `n` 的说明） */
  const seqOf = (v) => {
    const n = Number.parseInt(String(v ?? '').replace(/^#/, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const list = {
    name: 'gallery_list',
    description:
      '看你的图库里有哪些图。每行是「#序号  文件名  描述」，序号就是发图时要写的。'
      + '想知道某张图是什么、什么时候该发、该避开什么场合，都看这里。'
      + '要发图时写 `<<image: #序号>>`（图和文字同一条）或 `<<image-alone: #序号>>`（单独一条）。'
      + '**不要自己拼路径，也不要写网址**——只写序号。',
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

  const save = {
    name: 'gallery_save',
    description:
      '把一张图存进你的图库，会给它一个新序号。'
      + 'from="last" 表示存刚收到的那张图；也可以写一个本地文件路径。'
      + '存之前可以顺手给个名字和「什么场合用」，以后自己好找。'
      + '同一张图重复存不会多出第二条，会告诉你原来的序号。',
    parameters: {
      from: {
        type: 'string',
        required: true,
        description: '图从哪来：填 last（刚才那条消息里的图）或一个本地文件路径。不支持网址。',
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
        const r = saveOf({
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
      '改一张图的标注：名字、含义、关键词、适合的场合、要避开的场合、分类。'
      + '整理图库时用——把「未标注」的补上，把放错分类的挪过去。只改你给的那几个字段，别的不动。',
    parameters: {
      seq: { type: 'string', required: true, description: '要改的序号，比如 3 或 #3' },
      name: { type: 'string', description: '短名字，10 字以内' },
      meaning: { type: 'string', description: '这张图画的是什么、什么感觉' },
      tags: { type: 'string', description: '关键词，顿号或逗号隔开，最多 6 个' },
      scenes: { type: 'string', description: '什么场合适合发' },
      avoid: { type: 'string', description: '什么场合别发' },
      cat: { type: 'string', description: '分类名。给空串表示挪回未分类' },
      enabled: { type: 'string', description: '填 "0" 表示暂时不用这张（不删）' },
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

  return [list, save, edit, remove];
}

/**
 * 挂到 agent 上。失败不抛错，把原因带出去让面板显示。
 *
 * 和 `registerStickerTools` 一样的三级降级：真 `defineTool` → 普通对象 → 明确记日志。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerGalleryTools({ agent, listOf, saveOf, editOf, removeOf, callerOf, log = () => {} }) {
  const defs = buildGalleryToolDefs({ listOf, saveOf, editOf, removeOf, callerOf });
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
