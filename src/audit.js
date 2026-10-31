/**
 * 面板写操作的审计日志
 * ====================
 *
 * 为什么需要：面板能改人格、清记忆、开关静音、装插件。出了事（「谁把这个群的
 * 记忆清了」）现在只能翻应用日志猜，而应用日志是给人看流程的，不是给追责用的。
 *
 * 记什么：时间、操作名、目标会话、调用方身份摘要。**不记参数内容**——
 * `memory.clear` 的参数可能包含用户原文，审计日志不该变成第二个记忆库。
 *
 * 落盘：`<数据目录>/audit.log`，一行一个 JSON。不做轮转：
 * 一次点击一行、约 120 字节，一天点一千次也才 120 KB。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/**
 * 写一行审计。
 *
 * **失败不能影响操作本身**：磁盘满、权限错都不该让「清记忆」按钮点不动。
 * 所以这里吞掉异常，不往外抛。
 *
 * @param {{op:string, chatId?:string, peer?:string, peerId?:string, note?:string}} entry
 */
export function audit(entry = {}) {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });

    /**
     * **白名单字段**，不是把 entry 整个展开。
     *
     * 调用方哪天顺手多传一个 `arg`（比如被清掉的那条记忆原文），
     * 整段展开就会把它写进日志——审计日志就变成了第二个记忆库。
     * 只认这几个键，多传的直接丢弃。
     */
    const row = { at: Date.now() };
    for (const k of ['op', 'chatId', 'peer', 'peerId', 'note']) {
      const v = entry[k];
      if (v !== undefined && v !== '') row[k] = v;
    }

    appendFileSync(join(dir, 'audit.log'), `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // 审计是旁路，坏了不阻断业务
  }
}

/**
 * 把宿主交回的 Peer 压成可记录的一行。
 *
 * `principal` 缺席按 owner——**必须和 `fence.js` 的判定一致**，
 * 否则会出现「fence 放行了、审计却记成 unknown」的自相矛盾。
 *
 * id 只留前 8 位：够区分是谁，又不至于把完整标识写进日志。
 *
 * @param {object|null} peer
 * @returns {{kind:string, id:string}}
 */
export function peerSummary(peer) {
  if (!peer) return { kind: 'unknown', id: '' };
  const kind = peer?.principal?.kind ?? 'owner';
  return { kind: String(kind), id: String(peer?.id ?? '').slice(0, 8) };
}
