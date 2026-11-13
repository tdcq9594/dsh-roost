/**
 * 5.5 的可选项：AI 润色人格里的一段。
 * ==================================
 *
 * 定位很窄：**只改用户选中的那一段正文**，不碰 frontmatter、不碰段名、
 * 不碰其它段。人格是用户自己的作品，模型只当「改文字的助手」，
 * 任何让它顺手重写整份设计的做法都不做。
 *
 * 三条硬约束（都是踩过的坑）：
 *
 *   1. **结果不自动替换。** 返回给面板，用户点「采用」才写进去。直接覆盖的话，
 *      一次不满意的润色就把人写的东西弄丢了，而人格式没有 undo。
 *   2. **必须清洗模型输出。** 实测这类任务模型很爱回「好的，以下是改写后的版本：」
 *      外加 ``` 围栏。不清洗就会把客套话和围栏写进人格文件。
 *   3. **不喂人格全文。** 只给这一段 + 一段简短的风格提示。给全文会让模型
 *      忍不住「顺手优化一下别的地方」，而调用方只打算替换这一段，
 *      结果就是两边对不上。
 *
 * 失败一律 `ok:false` 带回原因，不抛：润色是编辑过程中的锦上添花，
 * 模型挂了不该让人连字都改不了。
 */

import { randomUUID } from 'node:crypto';

/** 一段最多润色多少字：再多就不是「一段」了，是整份人格 */
export const MAX_POLISH_CHARS = 4000;

/** 改写后最多能是原文的几倍：超过就警告（多半是模型自己扩写了一篇） */
export const MAX_GROWTH = 3;

/**
 * 预设。`hint` 是**给模型看的具体指令**，不是给人看的标签——
 * 写「更简洁」模型会给你删一半内容，写「删掉重复和空话，句子更短」才稳。
 */
export const POLISH_PRESETS = [
  {
    id: 'concise',
    label: '更简洁',
    hint: '删掉重复、空话和同义堆叠，句子更短；事实一个都不能少',
  },
  {
    id: 'spoken',
    label: '更口语',
    hint: '改成平时说话的样子，少用书面词和长定语；不要加语气词到每句结尾',
  },
  {
    id: 'inCharacter',
    label: '更贴人设',
    hint: '保持这段已有的设定，去掉和设定冲突、或明显不像这个角色的表达',
  },
  {
    id: 'detail',
    label: '补细节',
    hint: '把抽象的描述补成能演出来的具体细节（动作、习惯、反应），但不要新增设定里没有的事实',
  },
];

export const POLISH_PRESET_IDS = POLISH_PRESETS.map((p) => p.id);

/**
 * 清洗模型输出。
 *
 * 处理四类污染，顺序有讲究：
 *   1. 去掉 ``` 围栏（先去掉，否则后面的「首行」判断会被围栏干扰）；
 *   2. 去掉开头的客套行（「好的」「以下是改写后的版本：」）；
 *   3. 去掉开头多余的 `## 段名`（段名由调用方保留，模型不该带回来）；
 *   4. 收敛空行。
 */
export function cleanPolished(raw) {
  let s = String(raw ?? '').replace(/\r\n/g, '\n').trim();

  /** ```lang ... ``` 或 ``` ... ``` */
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();

  /**
   * 客套行：只在**第一行很短**时才删，避免把正文第一句「好的，我记住了」
   * 当成客套话删掉。判据 = 第一行 ≤ 30 字且以这些词开头且以冒号/句号结尾。
   */
  const lines = s.split('\n');
  if (lines.length > 1) {
    const head = lines[0].trim();
    if (head.length <= 30 && /^(好的|好，|以下是|这是|改写后|润色后|修改后|已按要求)/.test(head) && /[：:。.]$/.test(head)) {
      lines.shift();
      s = lines.join('\n').trim();
    }
  }

  /** 模型有时会自作主张带一行标题回来 */
  s = s.replace(/^#{1,3}\s+\S[^\n]*\n+/, '');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 组 prompt。`section` 只用来告诉模型「这是哪一类段落」，不进正文 */
export function buildPolishPrompt({ text = '', preset = '', instruction = '', section = '', personaName = '' } = {}) {
  const p = POLISH_PRESETS.find((x) => x.id === preset) || POLISH_PRESETS[0];
  const extra = String(instruction ?? '').trim().slice(0, 200);
  const who = String(personaName ?? '').trim();

  const rules = [
    `- ${p.hint}`,
    '- 保持原文的人称、时态和段落结构，不要合并或拆分段落',
    '- 不要添加原文没有的事实（名字、关系、经历、数字）',
    '- 不要输出标题、解释、前言或代码块，只输出改写后的正文',
  ];
  if (extra) rules.push(`- 用户额外要求：${extra}`);
  if (section) rules.push(`- 这段是人格里的「${section}」部分`);

  return [
    `你在帮${who ? `「${who}」的` : ''}使用者改写一段人格设定文本。要求：`,
    ...rules,
    '',
    '原文：',
    String(text ?? ''),
  ].join('\n');
}

/**
 * 润色一次。
 *
 * @param {object} o
 * @param {() => any} o.getLlm 取 `ctx.llm`（宿主没暴露就报错，不静默）
 * @param {{provider?:string, model?:string}} o.sel 用哪个模型
 * @param {string} o.text 要改的那段正文
 * @param {string} [o.preset] `POLISH_PRESETS[].id`
 * @param {string} [o.instruction] 用户额外要求（最多 200 字）
 * @param {string} [o.section] 段名，只作提示
 * @param {string} [o.personaName]
 * @param {number} [o.maxTokens]
 * @returns {Promise<{ok:boolean, text?:string, ms?:number, reason?:string, warnings?:string[]}>}
 */
export async function polishText({
  getLlm, sel, text, preset = 'concise', instruction = '', section = '', personaName = '', maxTokens = 2000,
} = {}) {
  const src = String(text ?? '').trim();
  if (!src) return { ok: false, reason: '这段是空的，没什么可改' };
  if ([...src].length > MAX_POLISH_CHARS) {
    return { ok: false, reason: `这段太长（${[...src].length} 字），润色最多 ${MAX_POLISH_CHARS} 字` };
  }

  const llm = (() => {
    try { return getLlm?.(); } catch { return null; }
  })();
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: '宿主没有暴露 llm.stream，用不了润色' };
  }
  const provider = String(sel?.provider ?? '').trim();
  const model = String(sel?.model ?? '').trim();
  if (!provider || !model) {
    return { ok: false, reason: '还没选模型，去「模型」页选一个再试' };
  }

  const started = Date.now();
  let raw = '';
  try {
    const stream = llm.stream({
      provider,
      model,
      system: '你只做文字润色，输出改写后的正文，不加任何解释。',
      messages: [{
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text: buildPolishPrompt({ text: src, preset, instruction, section, personaName }) }],
        source: { kind: 'plugin', plugin: 'dsh-roost' },
      }],
      maxTokens,
      /** 有点变化但不放飞：0 会让两次润色一字不差，1 以上开始改设定 */
      temperature: 0.7,
    });

    for await (const chunk of stream) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta') raw += String(chunk.text ?? '');
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {};
        return { ok: false, reason: `模型报错：${f.message || f.code || '未知'}` };
      }
    }
  } catch (e) {
    return { ok: false, reason: `润色失败：${e?.message || e}` };
  }

  const out = cleanPolished(raw);
  if (!out) return { ok: false, reason: '模型没返回内容，换个模型或再试一次' };

  const warnings = [];
  const ratio = [...out].length / Math.max(1, [...src].length);
  if (ratio > MAX_GROWTH) {
    warnings.push(`改写后是原文的 ${ratio.toFixed(1)} 倍，可能被扩写了，先对比一下`);
  }
  if (ratio < 0.3) {
    warnings.push('改写后不到原文三成，可能删掉了不该删的内容');
  }
  /** 段名/标题不该由模型带回来，清洗时已经去掉；这里只提醒可能改了结构 */
  if (/^#{1,3}\s/m.test(out)) {
    warnings.push('改写结果里出现了标题行，采用前确认一下结构');
  }

  return { ok: true, text: out, ms: Date.now() - started, warnings };
}
