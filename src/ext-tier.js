/**
 * 扩展权限分级（L0–L3）——纯函数，不读盘、不联网。
 *
 * 设计原则（抄 VS Code Workspace Trust + Chrome 权限警告）：
 *  1. **等级由声明自动推导**，索引里不存等级、清单里也不让作者自填等级 ——
 *     否则作者写个 "L0" 就能把「接管内置记忆」伪装成只读扩展。
 *  2. **未声明 / 认不出的按最保守处理**：未知 scope 直接抬到 L3。
 *     VS Code 不声明 `untrustedWorkspaces` 就按「受限模式禁用」。
 *  3. **风险说人话**：Chrome 不显示 `tabs`，而显示「读取你的浏览记录」。
 *     这里每个 scope 都有一句中文后果，安装时逐条列给主人看。
 *
 * 索引（index.json）只存 `scopes` / `overrides` / `form` 这些**原始声明**，
 * 它们受签名保护；等级在市场列表、安装确认、已装页三处由本模块现算。
 *
 * 参考：
 *  - VS Code Workspace Trust: github.com/dotnet/interactive/issues/1319
 *    `capabilities.untrustedWorkspaces.supported: true|false|"limited"`
 *  - Chrome Permission Warnings: github.com/quangpl/browser-extension-skills
 *    skills/extension-manifest/references/permission-warnings.md
 *  - S.C.O.P.E. 四级风险评分: github.com/BMR7AICyber/SCOPE-BrowserExtension
 */

/** 扩展运行形态。`core` 是「内置功能解离出来的核心扩展」的预留位。 */
export const FORMS = Object.freeze(['builtin', 'inprocess', 'mcp', 'core']);

export const FORM_INFO = Object.freeze({
  builtin: { label: '内建程序', note: '随程序一起发布，不可单独卸载或停用' },
  inprocess: { label: '进程内扩展', note: '在宿主进程里运行，响应最快，但崩溃会影响主程序' },
  mcp: { label: '外部扩展', note: '独立进程运行，崩溃不影响主程序；能力通过宿主接口受控开放' },
  core: { label: '核心扩展', note: '由内置功能解离而来，可关闭并交给用户自己的实现' },
});

/**
 * 每个 scope 的风险等级与人话后果。
 * `level` 是该 scope 单独能抬到的最低等级，整体取所有 scope 的最大值。
 */
export const SCOPE_INFO = Object.freeze({
  'state:read': { level: 0, text: '读取机器人的状态、心情与当前设定' },
  'context:read': { level: 0, text: '读取当前会话的上下文' },
  'memory:read': { level: 0, text: '读取她的记忆' },

  'memory:write': { level: 1, text: '写入、修改或删除她的记忆' },
  'message:write': { level: 1, text: '以机器人身份往 QQ 会话发消息（含图文卡片）' },
  'session:write': { level: 1, text: '创建或切换 QQ 会话' },

  'proactive:write': { level: 2, text: '不经你逐条同意，主动给你或群里发消息' },
  'say:write': { level: 2, text: '让机器人主动开口说话' },
  'prompt:write': { level: 2, text: '修改人格设定与模型选择' },
  'agent:write': { level: 2, text: '开独立 AI 会话、调用模型，消耗你的额度' },

  /** 阶段：内置功能解离后启用；本轮只做声明与告知，不实现实际替换。 */
  'core:write': { level: 3, text: '关闭或接管程序内置功能' },
});

/**
 * 可被核心扩展接管的内置能力（后续逐个解离时往这里加）。
 * 本轮只做**声明与告知**，不实现实际替换；名字要用人话，别把 `memory`
 * 这种内部键直接摆到安装确认框里。
 */
export const CORE_POINTS = Object.freeze({
  memory: { label: '记忆系统', text: '关闭内置记忆系统，改由这个扩展接管她的记忆读写' },
  prompt: { label: '提示词组装', text: '接管系统提示词的组装方式' },
  channels: { label: '消息通道', text: '接管消息的实际发送通道' },
  tools: { label: '工具表', text: '接管模型能使用的工具清单' },
  'outbound-actions': { label: '出站动作', text: '接管消息里的卡片、图片等出站动作解析' },
  ui: { label: '面板页面', text: '接管或替换内置面板页面' },
});

/** 与 ext-registry.js 的 EXT_DEFAULT_SCOPES 一致，由 test/ext-tier.test.js 守门。 */
export const DEFAULT_SCOPES = Object.freeze(['memory:write', 'state:read']);

export const TIERS = Object.freeze({
  L0: {
    level: 0, label: '只读', badge: 'safe', color: 'green', confirm: 'none',
    summary: '只在自己的目录里读数据，不会替你发消息，也不会改动程序行为。',
  },
  L1: {
    level: 1, label: '常规', badge: 'notice', color: 'blue', confirm: 'none',
    summary: '会替机器人写记忆或发消息，但不主动开口、不改设定、不碰内置功能。',
  },
  L2: {
    level: 2, label: '敏感', badge: 'warn', color: 'orange', confirm: 'checkbox',
    summary: '能主动开口、调用模型烧额度，或修改人格与模型设定。',
  },
  L3: {
    level: 3, label: '核心接管', badge: 'danger', color: 'red', confirm: 'type-name',
    summary: '会关闭或接管程序内置功能（如整个记忆系统），停用扩展才能恢复；期间原有行为与数据格式可能不兼容。',
  },
});

const TIER_IDS = ['L0', 'L1', 'L2', 'L3'];

function listOf(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => typeof x === 'string' && String(x).trim()).map((x) => String(x).trim()))];
}

/**
 * 从扩展清单推导权限等级。
 *
 * @param {object} manifest `plugin.json` 或 index.json 条目（原始声明）
 * @returns {{
 *   id: 'L0'|'L1'|'L2'|'L3', level: number, label: string,
 *   form: string, formLabel: string, scopes: string[], overrides: string[],
 *   reasons: Array<{kind:string, key:string, text:string, level:number}>,
 *   unknownScopes: string[], summary: string, confirm: string,
 * }}
 */
export function deriveTier(manifest = {}) {
  const declared = Array.isArray(manifest?.scopes) ? manifest.scopes : null;
  /** 没写 scopes 的老扩展会拿到默认权限，展示要按实际会拿到的算，别虚低 */
  const scopes = listOf(declared ?? DEFAULT_SCOPES);
  const overrides = listOf(manifest?.overrides);
  const rawForm = String(manifest?.form ?? '').trim();
  /** 没写 form 的老扩展按实际运行形态推断：进程内 ui 动作优先，否则外部 MCP */
  const inferred = manifest?.ui?.runtime === 'inprocess' ? 'inprocess' : 'mcp';
  const form = FORMS.includes(rawForm) ? rawForm : inferred;

  const reasons = [];
  const unknownScopes = [];
  let level = 0;

  for (const s of scopes) {
    const info = SCOPE_INFO[s];
    if (!info) {
      /** 认不出的权限按最高风险处理：宁可多问一句，不能漏放 */
      unknownScopes.push(s);
      reasons.push({ kind: 'scope', key: s, level: 3, text: `未知权限「${s}」：无法确认它会做什么` });
      level = Math.max(level, 3);
      continue;
    }
    reasons.push({ kind: 'scope', key: s, level: info.level, text: info.text });
    level = Math.max(level, info.level);
  }

  if (overrides.length) {
    for (const name of overrides) {
      const point = CORE_POINTS[name];
      reasons.push({
        kind: 'override', key: name, level: 3,
        text: point
          ? `将关闭或接管内置${point.label}：${point.text}`
          : `声明接管未知内置能力「${name}」：无法确认它会改什么，按最高风险处理`,
      });
    }
    level = Math.max(level, 3);
  }
  if (form === 'core') {
    reasons.push({ kind: 'form', key: form, level: 3, text: '这是可关闭、可替换的核心扩展' });
    level = Math.max(level, 3);
  }
  if (!FORMS.includes(rawForm) && rawForm) {
    reasons.push({ kind: 'form', key: rawForm, level: 3, text: `未知运行形态「${rawForm}」` });
    level = Math.max(level, 3);
  }

  const id = TIER_IDS[level];
  const t = TIERS[id];
  return {
    id, level, label: t.label, badge: t.badge, color: t.color,
    confirm: t.confirm, summary: t.summary,
    form, formLabel: FORM_INFO[form].label, formNote: FORM_INFO[form].note,
    scopes, overrides, reasons, unknownScopes,
  };
}

/** 安装确认用的逐条人话清单（按风险从高到低）。 */
export function riskLines(derived) {
  return [...(derived?.reasons ?? [])]
    .sort((a, b) => b.level - a.level)
    .map((r) => ({ level: r.level, text: r.text }));
}

/**
 * 安装确认文案。L0/L1 不用打扰；L2 要勾选；L3 要输入扩展名二次确认。
 * 现有 `confirmScopes:true` 保持兼容（等价于已通过任一等级确认）。
 */
export function installNotice(derived, { name = '' } = {}) {
  const d = derived ?? deriveTier({});
  const lines = riskLines(d);
  const head = `扩展「${name}」权限等级 ${d.id}（${d.label}）：${d.summary}`;
  const body = lines.length
    ? `\n它会：\n${lines.map((x) => `  · ${x.text}`).join('\n')}`
    : '\n它没有申请任何额外权限。';
  const tail = d.level >= 3
    ? `\n⚠️ 这是最高等级。安装后它会接管上述内置功能，期间原有数据可能不兼容；停用扩展才能恢复。请确认你信任这个扩展的作者。`
    : d.level === 2
      ? '\n请确认你愿意授予这些权限后再安装。'
      : '';
  return head + body + tail;
}
