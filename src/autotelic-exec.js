/**
 * 自驱执行分级 · 硬禁区检测（纯函数层）——移植自 aurabot-beta `src/autotelic/exec.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见
 * THIRD-PARTY-NOTICES.md。createExecV5（依赖 hooks/快照/确认队列）不在这里。
 *
 * 口径（原文保留）：这是「正则黑名单 + 默认执行通道 noTools 的物理限制」双兜底，
 * 不是「语义上不可能表达」——自由文本改述可能绕过正则，noTools 通道才是真防线。
 */
export const LEVELS = Object.freeze(['read-only', 'write-data', 'touch-owner'])

/** 瞬态错误识别（坑#7：冷却/超时是瞬态，冤死过 4 个任务）。 */

export const TRANSIENT_RE = /冷却|等太久|还没结束|超时|timeout|timed?\s*out|ECONNRESET|断线/i

/** 单步瞬态退避上限：瞬态也不许无限退避，超过按失败算。 */

const MAX_TRANSIENT = 3

// ── 硬禁区检测（代码层拦截，先于一切执行） ─────────────────────────────────
// 五类样本：宿主/插件配置、源码、凭据/登录态、聊天流水/记忆原始数据（删除类）、任意 shell。
// 措辞口径（集成审查中危 10，2026-11-17）：这是**正则黑名单 + 默认执行通道 noTools 的物理
// 限制双兜底**，不是「语义上不可能表达」——自由文本改述可能绕过正则，但 noTools 通道让她
// 真的做不了文件/进程操作，两层一起才算防线。
//
// 正则口径（2026-11-18 审查修正）：黑名单**只该拦「明确指向执行能力」的说法**，不能拦
// 中文/拼音/缩写里恰好长得像的词。上一版 RE_SHELL 里的 `\bsh\b`、`\brm\s`、`\bdel\s`
// 误伤面太大（实测：`sh 开头的歌`、`sh 音标`、`记录 rm -rf 的危险性`、`del 掉过期草稿`
// 全被整单 rejected），而它们对安全几乎不增益 —— 真正的 shell 能力来自执行通道，
// 那一层已由 `noTools: true` 物理掐断。故删掉这三个高误伤项。

const RE_HOST_CONFIG = /host\.json|profiles?[/\\]|plugin[-.]?config|settings\.json|config\.(json|ya?ml|toml)\b/i

const RE_SOURCE_CODE = /(^|[/\\])src[/\\]|node_modules[/\\]|package\.json\b|\.js\b.*源码|源码|源代码/i

const RE_CREDENTIAL = /凭据|登录态|cookie|token|secret|apikey|api[_-]?key|password|passwd|session[-_]?file|credential/i

const RE_DELETE_CHAT_MEMORY = /(聊天流水|聊天记录|对话记录|记忆原始|memory[/\\]|chats?[/\\]|messages?\.json|history\.json|流水)/i
// 只留明确无歧义、指向「执行环境」的说法。`终端` 单独保留：它在中文里几乎只指 terminal
// （不像 sh/rm/del 那样会撞上拼音、音标、缩写），是这条正则里性价比最高的一个词。

const RE_SHELL = /powershell|pwsh\b|\bbash\b|cmd\.exe|命令行|终端|shell 脚本|shell脚本|执行命令|运行命令|\bexec\s*\(|\bspawn\s*\(/i

const RE_DELETE_VERB = /(删除|删掉|清空|清除|抹掉|移除|挪走|清掉|delete|remove|purge|wipe|mv)/i

const RE_WRITE_VERB = /(修改|改|写入|写|覆盖|编辑|外传|上传|导出|挪动|移动|edit|write|modify|overwrite|export|exfiltrate|move)/i

/**
 * 判定一步是否落在硬禁区。返回 { forbidden:boolean, why:string }。
 * 判据按字段归并成一段文本做模式匹配：模板没有表达空间，命中即拒，不做语义豁免。
 */

export function isForbidden(step) {
  const blob = [
    step?.kind, step?.action, step?.desc, step?.target, step?.path, step?.tool,
  ].filter(Boolean).join(' | ')
  if (RE_SHELL.test(blob)) return { forbidden: true, why: '硬禁区：任意 shell 不在行动单的表达空间' }
  if (RE_HOST_CONFIG.test(blob) && (RE_WRITE_VERB.test(blob) || RE_DELETE_VERB.test(blob))) {
    return { forbidden: true, why: '硬禁区：不许改宿主/插件配置' }
  }
  if (RE_SOURCE_CODE.test(blob) && (RE_WRITE_VERB.test(blob) || RE_DELETE_VERB.test(blob))) {
    return { forbidden: true, why: '硬禁区：不许改框架/插件源码' }
  }
  if (RE_CREDENTIAL.test(blob)) return { forbidden: true, why: '硬禁区：不许读写/外传凭据与登录态' }
  if (RE_DELETE_CHAT_MEMORY.test(blob) && RE_DELETE_VERB.test(blob)) {
    return { forbidden: true, why: '硬禁区：不许删聊天流水与记忆原始数据' }
  }
  return { forbidden: false, why: '' }
}

/** 校验行动单形状；不合法返回原因串，合法返回 ''。 */

