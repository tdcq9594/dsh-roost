/**
 * 5.5 人格分节编辑：把一份 .md 切成「任意多段」，再把段拼回去。
 * ==============================================================
 *
 * 为什么不在前端切：`parsePersona()` 认三种标题格式（`## ` / `一、` /
 * `第X部分 ·`），还认「回复示例」这个别名；前端再抄一份必然漂移。
 *
 * 两套视图并存（只增不减）：
 *   · `sections` —— 固定四段（性格 / 开场白 / 说话示例 / 世界书），
 *     和 `parsePersona` 语义一致，老接口与已有测试继续用；
 *   · `blocks`   —— 正文里**每一个标题**一段的有序数组，段名和内容都能改、
 *     能删、能加。未命名的标题段（如 `## 性格底色`）也各占一段。
 *
 * 两条硬约束：
 *   1. frontmatter 原样保留——里面有 `tools: []` 这类限制，丢了会静默失效；
 *   2. round-trip 内容不丢：没改过段名的段，写回时沿用**原始标题行**
 *      （`一、开场白` 不会被悄悄改成 `## 开场白`）。
 */

export const PERSONA_SECTIONS = [
  {
    key: 'body', label: '性格与设定', defaultTitle: '',
    hint: '正文骨架。段名留空就是无标题正文，填了就会写成 ## 段名。',
  },
  {
    key: 'firstMes', label: '开场白', defaultTitle: '## 开场白',
    hint: '主动搭话时直接用的第一句。改了段名就不再按开场白解析。',
  },
  {
    key: 'demos', label: '说话示例', defaultTitle: '## 说话示例',
    hint: '两三轮真实对话，校准长度、语气词和标点习惯。',
  },
  {
    key: 'lore', label: '世界书', defaultTitle: '## 世界书',
    hint: '一行一条：触发词1, 触发词2 | 内容（命中才注入）。',
  },
];

/** 一次最多存多少段：防误粘贴把整本书塞进来 */
export const MAX_BLOCKS = 60;

/** 标题里的关键词 → 段 key。顺序有讲究：长的在前，避免「说话示例」被前缀吃掉 */
const KEY_OF = [
  ['说话示例', 'demos'],
  ['回复示例', 'demos'],
  ['开场白', 'firstMes'],
  ['世界书', 'lore'],
];

/** 和 parsePersona 的 HEAD_RE 同款三种写法；这里用来切「任意」标题 */
const TITLE_RE =
  /^\s*(?:#{1,3}\s*|[一二三四五六七八九十]{1,3}、\s*|第[一二三四五六七八九十]{1,3}部分\s*[·・:：\-—]\s*)(.+?)\s*$/;

/** 从标题行里取纯段名（去掉前缀符号与括号里的说明） */
export function titleNameOf(line) {
  const m = String(line ?? '').match(TITLE_RE);
  return m ? String(m[1] ?? '').replace(/[（(].*?[)）]/g, '').trim() : '';
}

function keyOfTitle(line) {
  const raw = titleNameOf(line);
  if (!raw) return null;
  for (const [kw, key] of KEY_OF) if (raw === kw || raw.includes(kw)) return key;
  return null;
}

/**
 * 自动识别已有文档里的段名。
 *
 * `parsePersona` 只认三种标题格式；但用户手写的人格里还有 `【性格】`、
 * `**禁忌**`、`1. 节奏`、`性格：` 这些很自然的写法。分节编辑要把它们也
 * **自动提出来**（段名 + 内容），不能让用户对着一份现成文档重新手敲一遍。
 *
 * 只用于 `blocks` 视图；固定四段视图仍按严格 TITLE_RE 走，语义不变。
 * 约束：单独成行、不超过 40 字、排除列表项 / 世界书表格行，避免把正文
 * 里「她说过：什么」这种句子误判成标题。
 */
export function looseTitleOf(line) {
  const s = String(line ?? '').trim();
  if (!s || s.length > 40 || /[|｜]/.test(s) || /^[-*·>]\s/.test(s)) return '';
  const clean = (v) => String(v ?? '').replace(/[（(].*?[)）]/g, '').replace(/[：:]+$/, '').trim();
  let m;
  if ((m = s.match(/^#{1,6}\s+(.+)$/))) return clean(m[1]);
  if ((m = s.match(/^[一二三四五六七八九十]{1,3}、\s*(.+)$/))) return clean(m[1]);
  if ((m = s.match(/^第[一二三四五六七八九十]{1,3}部分\s*[·・:：\-—]\s*(.+)$/))) return clean(m[1]);
  if ((m = s.match(/^\d{1,2}[.、)]\s*(.+)$/))) return clean(m[1]);
  if ((m = s.match(/^[【\[](.+?)[】\]]$/))) return clean(m[1]);
  if ((m = s.match(/^\*\*(.+?)\*\*$/))) return clean(m[1]);
  if ((m = s.match(/^(.{1,20})[：:]$/))) return clean(m[1]);
  return '';
}

/**
 * @param {string} raw 完整的人格 markdown
 * @returns {{front:string, sections:Object, titles:Object, order:string[], blocks:Array, raw:string}}
 */
export function splitPersonaText(raw) {
  const text = String(raw ?? '');
  /** 头部匹配与 parsePersona 一致：容忍前导空行、尾随空格、空头 */
  const m = text.match(/^\s*---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/);
  const front = m ? m[0] : '';
  const rest = m ? text.slice(m[0].length) : text;

  /** 先按「所有标题」切成 segment，后面再派生两套视图 */
  const segments = [];
  let cur = { titleLine: '', title: '', key: null, lines: [] };
  for (const line of rest.split(/\r?\n/)) {
    /** 自动识别段名：常见标题写法都算，识别不出来的行老老实实当正文 */
    const title2 = looseTitleOf(line);
    if (title2) {
      segments.push(cur);
      cur = { titleLine: line, title: title2, key: keyOfTitle(line), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  segments.push(cur);

  /** ① 固定四段视图：非命名段（含自定义标题段）原样并进 body */
  const sections = { body: '', firstMes: '', demos: '', lore: '' };
  const titles = {};
  const order = [];
  const bodyLines = [];
  const usedKeys = new Set();
  for (const seg of segments) {
    const isBuiltin = Boolean(seg.key) && !usedKeys.has(seg.key);
    if (isBuiltin) {
      usedKeys.add(seg.key);
      sections[seg.key] = seg.lines.join('\n').trim();
      titles[seg.key] = seg.titleLine;
      order.push(seg.key);
    } else {
      if (seg.titleLine) bodyLines.push(seg.titleLine);
      bodyLines.push(...seg.lines);
    }
  }
  sections.body = bodyLines.join('\n').trim();

  /** ② 逐段视图：每一段都能改名 / 改内容 / 删 / 加 */
  const blocks = [];
  const usedForBlocks = new Set();
  let customIdx = 0;
  for (const seg of segments) {
    const text2 = seg.lines.join('\n').trim();
    if (!seg.titleLine) {
      if (text2) blocks.push({ key: 'body', title: '', titleLine: '', text: text2, builtin: true, custom: false });
      continue;
    }
    const isBuiltin = Boolean(seg.key) && !usedForBlocks.has(seg.key);
    if (isBuiltin) usedForBlocks.add(seg.key);
    blocks.push({
      key: isBuiltin ? seg.key : 'custom:' + customIdx++,
      title: seg.title,
      titleLine: seg.titleLine,
      text: text2,
      builtin: Boolean(isBuiltin),
      custom: !isBuiltin,
    });
  }

  return { front, sections, titles, order, blocks, raw: text };
}

/**
 * 老接口：用服务端当前文件当骨架，只替换固定四段。
 * 清空某一段 = 删掉那一段（标题也不留）。
 */
export function joinPersonaText(snapshot, next = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : splitPersonaText('');
  const merged = {};
  for (const { key } of PERSONA_SECTIONS) {
    merged[key] = String(next?.[key] ?? snap.sections?.[key] ?? '').trim();
  }

  const parts = [];
  if (snap.front) parts.push(String(snap.front).replace(/\s+$/, ''));
  if (merged.body) parts.push(merged.body);

  const seen = new Set();
  const order = Array.isArray(snap.order) ? snap.order : [];
  const keys = [...order, ...PERSONA_SECTIONS.slice(1).map((x) => x.key)];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const text = merged[key];
    if (!text) continue;
    const spec = PERSONA_SECTIONS.find((x) => x.key === key);
    const title = String(snap.titles?.[key] || spec?.defaultTitle || '').trim();
    parts.push(title ? `${title}\n${text}` : text);
  }
  return parts.join('\n\n') + '\n';
}

/** 前端传回来的 blocks 先收窄：只留三个字段，段名不许带换行 */
export function sanitizeBlocks(raw) {
  if (!Array.isArray(raw)) return null;
  const one = (s, max) => String(s ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, max);
  return raw.slice(0, MAX_BLOCKS).map((b) => ({
    title: one(b?.title, 80),
    titleLine: one(b?.titleLine, 200),
    text: String(b?.text ?? ''),
  }));
}

/**
 * 新接口：按用户排好的顺序逐段写回。
 *
 * 段名没改 → 沿用原始标题行（`一、开场白` 原样保留）；
 * 段名改了 / 新加的段 → 统一写成 `## 段名`；
 * 段名清空 → 这段变成无标题正文。
 * frontmatter 仍以**服务端当前文件**为准，前端传什么都不覆盖它。
 */
export function joinPersonaBlocks(snapshot, blocks = []) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : splitPersonaText('');
  const list = sanitizeBlocks(blocks) || [];
  const parts = [];
  if (snap.front) parts.push(String(snap.front).replace(/\s+$/, ''));
  for (const b of list) {
    const text = String(b.text ?? '').trim();
    if (!text) continue;
    const name = String(b.title ?? '').trim();
    if (!name) {
      parts.push(text);
      continue;
    }
    const original = String(b.titleLine ?? '').trim();
    /** 段名没改就沿用原始标题行；宽松识别的 `【x】` 也要比对得上 */
    const was = looseTitleOf(original) || titleNameOf(original);
    const line = (!original || name !== was) ? `## ${name}` : original;
    parts.push(`${line}\n${text}`);
  }
  return parts.join('\n\n') + '\n';
}
