/**
 * 5.11 安全防护之一：危险命令的「先在 QQ 里回确认」。
 *
 * 模型会在一轮里自己决定调工具。删根目录、格式化、关机、下载后直接执行
 * 这类命令，一旦被提示词注入或幻觉触发，后果是不可逆的。
 *
 * 做法是**一次性闸门**：拦下这次调用 → 在 QQ 里问一句 → 用户回「确认」→
 * 只放行**下一条同类型**命令。确认不会变成长期授权，也不会让后续任意
 * 危险命令连过。
 *
 * 这里全是纯逻辑（不发消息、不读配置），host 只负责把 `send` 接进来。
 */

/** 规则按「宁可多问一次，不可漏放一条」写；误报的代价只是多回一句确认 */
/** 递归/强制标记：rm 类规则共用，拆开写比一条巨型正则可靠 */
const RECURSIVE_GUARD = /(?:^|[\s"'])(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force|-Recurse|-Force|-R)(?=[\s"']|$)/i;
const RULES = [
  { id: 'rm-root', reason: '递归删除根目录 / 家目录',
    guard: RECURSIVE_GUARD,
    /**
     * 目标分三类：根（含引号、`/*`）、用 `..` 绕回根（`/tmp/../`）、
     * 家目录 / 盘符 / 环境变量。`rm -rf ./node_modules` 都不沾，不误报。
     * 2026-11-14 对抗测试：`--recursive --force /`、`/tmp/../`、`"/"` 旧版全漏。
     */
    /** 结尾用 lookahead：参数经 `JSON.stringify` 后会带 `"` `}` `]` 这类结构字符 */
    res: [
      /\b(?:rm|Remove-Item)\b[^\n]{0,160}?\s+["']?\/(?:\*)?["']?(?=[\s;|&)\]}"',\\]|$)/i,
      /\b(?:rm|Remove-Item)\b[^\n]{0,160}?\s+["']?\/[^\s"']*(?:\/\.\.)+[^\s"']*["']?(?=[\s;|&)\]}"',\\]|$)/i,
      /\b(?:rm|Remove-Item)\b[^\n]{0,160}?\s+["']?(?:~\/?|\$HOME\b|C:[\\/]|%[A-Za-z]+%)/i,
    ] },
  { id: 'rm-system', reason: '递归删除系统目录',
    /**
     * 清单 P2：`rm -rf /etc`、`/var/www` 旧版不拦。`/tmp` 故意不列——
     * 清构建缓存是日常操作，误报比漏报更招人烦。key 与 rm-root 分开，
     * 确认删家目录不会顺带解锁删系统目录。
     */
    guard: RECURSIVE_GUARD,
    re: /\b(?:rm|Remove-Item)\b[^\n]{0,160}?\s+["']?\/(?:etc|var|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|opt|srv|Windows|Program[\s_-]Files|System|Applications)(?=[\/\\"'\s]|$)/i },
  { id: 'del-tree', reason: '递归删除文件树',
    re: /\bdel\s+\/[sSqQ]/i },
  { id: 'format', reason: '格式化 / 重建文件系统',
    re: /\b(?:mkfs(?:\.\w+)?|format|diskpart)\b/i },
  { id: 'power', reason: '关机 / 重启',
    re: /\b(?:shutdown|poweroff|halt|reboot|init\s+[06]|Stop-Computer|Restart-Computer)\b/i },
  { id: 'dd', reason: '直接写块设备',
    re: /\bdd\s+if=/i },
  { id: 'download-exec', reason: '下载后立刻执行（网络内容直接进 shell）',
    /**
     * 管道、分号 / &&、命令替换（含反引号 / `<(`）、下载到文件再执行，
     * 四种写法各一条。2026-11-14 对抗测试实测旧版只认第一种，其余全漏。
     */
    res: [
      /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i,
      /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]{0,300}(?:;|&&|\|\|)[^\n]{0,200}\b(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i,
      /\b(?:sh|bash|zsh|powershell|pwsh|cmd)\b[^\n]{0,120}(?:\$\(|<\(|`)[^\n]{0,200}(?:curl|wget|Invoke-WebRequest|iwr)\b/i,
      /(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]{0,200}(?:-o|--output|-OutFile)\s+\S+[^\n]{0,200}\b(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i,
    ] },
  { id: 'chmod-root', reason: '递归改动根目录权限',
    re: /\b(?:chmod|chown)\b[^\n]{0,60}(?:-R|--recursive)[^\n]{0,60}\s+(?:\/|\*)/i },
  { id: 'fork-bomb', reason: 'fork 炸弹',
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: 'reg-delete', reason: '删除注册表键',
    re: /\breg\s+delete\b|\bRemove-ItemProperty\b[^\n]*-Name\s+/i },
];

/**
 * 只认强意图短语。旧版把 ok / yes / go / 确定 / 继续 / 执行 都当批准，
 * 主人正常说一句「ok」就可能放行一条待确认的 `rm -rf`。
 * 保留「确认」：`ask()` 的提示文案和 host 的接线测试都用它。
 */
const CONFIRM_RE = /^\s*确认(?:执行|运行)?\s*[!！。.]?\s*$/;

/**
 * 判断一次工具调用是不是危险命令。
 * @param {string} name 工具名
 * @param {unknown} args 参数（对象/字符串都会转成文本）
 * @returns {{dangerous:boolean, key:string, reason:string, matched:string, fingerprint:string}}
 */
export function isDangerousCommand(name, args) {
  let text;
  try {
    text = `${String(name ?? '')} ${typeof args === 'string' ? args : JSON.stringify(args ?? '')}`;
  } catch {
    text = `${String(name ?? '')} ${String(args ?? '')}`;
  }
  /** 同 key 不同目标不能共用一次批准：把命令本身规范化后当绑定指纹 */
  const fingerprint = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  for (const r of RULES) {
    if (r.guard && !r.guard.test(text)) continue;
    const patterns = r.res || [r.re];
    if (patterns.some((p) => p.test(text))) {
      return { dangerous: true, key: r.id, reason: r.reason, matched: r.id, fingerprint };
    }
  }
  return { dangerous: false, key: '', reason: '', matched: '', fingerprint: '' };
}

/**
 * 从一次工具调用里挑出「可能含命令文本」的字段给扫描器。
 *
 * 函数本体本来就 `JSON.stringify(args)` 全字段扫，漏检发生在**调用点**：
 * host 以前只传 `exec?.args ?? exec?.input`，命令落在 `script` / `query` /
 * `payload` 里就整条绕过。这里反过来排除已知的纯元数据字段，避免把
 * session id、文件名之类的无害字符串混进去造成误报。
 */
/**
 * 纯元数据 / 上一次的工具输出不进扫描器：它们不是「这次要执行的命令」，
 * 扫它们只会把历史里出现过的危险字样反复当成新命令，白问确认。
 */
const META_KEYS = new Set([
  'agent', 'session', 'meta', 'trace', 'id', 'name', 'tool', 'at', 'ts',
  'output', 'result', 'stdout', 'stderr', 'history', 'previous',
]);
export function dangerScanArgs(exec) {
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return exec;
  const out = {};
  for (const [k, v] of Object.entries(exec)) {
    if (!META_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * 一次性确认闸门。
 * @param {{send?:(chatId:string,text:string)=>void, now?:()=>number, ttlMs?:number}} o
 */
export function createConfirmGate({ send = () => {}, now = () => Date.now(), ttlMs = 5 * 60_000 } = {}) {
  /** chatId → { key, at }：等用户回确认 */
  const pending = new Map();
  /** chatId → { key, at }：已确认，消费一次就删 */
  const approved = new Map();

  const fresh = (rec) => Boolean(rec) && now() - rec.at <= ttlMs;

  return {
    /** 拦下这次调用，并在 QQ 里问一句 */
    ask(chatId, danger) {
      const key = String(danger?.key || 'unknown');
      pending.set(String(chatId), { key, at: now(), fp: String(danger?.fingerprint || '') });
      send(String(chatId), `这条命令有风险（${danger?.reason || '危险操作'}），要我执行就回「确认」；5 分钟内有效，只放这一次。`);
    },
    /** 用户回了一句：只有存在待确认且精确匹配时才算数，绝不吞正常聊天 */
    onMessage(chatId, text) {
      const k = String(chatId);
      const p = pending.get(k);
      if (!p) return false;
      if (!fresh(p)) { pending.delete(k); return false; }
      if (!CONFIRM_RE.test(String(text ?? ''))) return false;
      approved.set(k, { key: p.key, at: now(), fp: p.fp });
      pending.delete(k);
      return true;
    },
    /**
     * 放行前调：匹配且没过期就消费掉。
     * 传了 `fingerprint` 就必须和确认时那条命令一致——否则「确认删
     * 这个临时目录」会连带放行紧接着的另一条 `rm -rf /`。
     */
    consume(chatId, key, fingerprint) {
      const k = String(chatId);
      const a = approved.get(k);
      if (!a || a.key !== String(key) || !fresh(a)) return false;
      if (a.fp && fingerprint && a.fp !== String(fingerprint)) return false;
      approved.delete(k);
      return true;
    },
    hasPending: (chatId) => Boolean(fresh(pending.get(String(chatId)))),
    get size() { return pending.size; },
  };
}
