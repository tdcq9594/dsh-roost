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
const RULES = [
  { id: 'rm-root', reason: '递归删除根目录 / 家目录',
    /** 目标必须是「空白后紧跟根/家目录」：rm -rf ./node_modules 是正常清理，不误报 */
    re: /\b(?:rm|Remove-Item)\b[^\n]{0,80}(?:-rf|-fr|-r\s+-f|-Recurse[^\n]*-Force)[^\n]{0,40}\s+(?:\/(?:\s|$|\*|["'])|~(?:[\/\s]|$|["'])|\$HOME\b|C:\\|%[A-Za-z]+%)/i },
  { id: 'del-tree', reason: '递归删除文件树',
    re: /\bdel\s+\/[sSqQ]/i },
  { id: 'format', reason: '格式化 / 重建文件系统',
    re: /\b(?:mkfs(?:\.\w+)?|format|diskpart)\b/i },
  { id: 'power', reason: '关机 / 重启',
    re: /\b(?:shutdown|poweroff|halt|reboot|init\s+[06]|Stop-Computer|Restart-Computer)\b/i },
  { id: 'dd', reason: '直接写块设备',
    re: /\bdd\s+if=/i },
  { id: 'download-exec', reason: '下载后立刻执行（网络内容直接进 shell）',
    re: /(?:curl|wget|Invoke-WebRequest|iwr)[^\n]{0,300}\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i },
  { id: 'chmod-root', reason: '递归改动根目录权限',
    re: /\b(?:chmod|chown)\b[^\n]{0,60}(?:-R|--recursive)[^\n]{0,60}\s+(?:\/|\*)/i },
  { id: 'fork-bomb', reason: 'fork 炸弹',
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: 'reg-delete', reason: '删除注册表键',
    re: /\breg\s+delete\b|\bRemove-ItemProperty\b[^\n]*-Name\s+/i },
];

const CONFIRM_RE = /^\s*(?:确认|确定|执行|继续|confirm|yes|ok|go)\s*[!！。.]?\s*$/i;

/**
 * 判断一次工具调用是不是危险命令。
 * @param {string} name 工具名
 * @param {unknown} args 参数（对象/字符串都会转成文本）
 * @returns {{dangerous:boolean, key:string, reason:string, matched:string}}
 */
export function isDangerousCommand(name, args) {
  let text;
  try {
    text = `${String(name ?? '')} ${typeof args === 'string' ? args : JSON.stringify(args ?? '')}`;
  } catch {
    text = `${String(name ?? '')} ${String(args ?? '')}`;
  }
  for (const r of RULES) {
    if (r.re.test(text)) return { dangerous: true, key: r.id, reason: r.reason, matched: r.id };
  }
  return { dangerous: false, key: '', reason: '', matched: '' };
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
      pending.set(String(chatId), { key, at: now() });
      send(String(chatId), `这条命令有风险（${danger?.reason || '危险操作'}），要我执行就回「确认」；5 分钟内有效，只放这一次。`);
    },
    /** 用户回了一句：只有存在待确认且精确匹配时才算数，绝不吞正常聊天 */
    onMessage(chatId, text) {
      const k = String(chatId);
      const p = pending.get(k);
      if (!p) return false;
      if (!fresh(p)) { pending.delete(k); return false; }
      if (!CONFIRM_RE.test(String(text ?? ''))) return false;
      approved.set(k, { key: p.key, at: now() });
      pending.delete(k);
      return true;
    },
    /** 放行前调：匹配且没过期就消费掉 */
    consume(chatId, key) {
      const k = String(chatId);
      const a = approved.get(k);
      if (!a || a.key !== String(key) || !fresh(a)) return false;
      approved.delete(k);
      return true;
    },
    hasPending: (chatId) => Boolean(fresh(pending.get(String(chatId)))),
    get size() { return pending.size; },
  };
}
